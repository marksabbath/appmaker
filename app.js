#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var
express = require('express'),
http = require('http'),
engine = require('ejs-locals'),
path = require('path'),
uuid = require('node-uuid'),
cors = require('cors'),
connectFonts = require('connect-fonts'),
postmark = require("postmark")(process.env.POSTMARK_API_KEY),
lessMiddleware = require('less-middleware'),
enableRedirects = require('./routes/redirects'),
i18n = require('webmaker-i18n'),
components = require('./lib/components'),
localeBuild = require('./lib/localeBuild'),
bundles = require('./lib/bundles'),
middleware = require('./lib/middleware'),
localComponents = [];

try {
  // This does a pretty great job at figuring out booleans.
  if (process.env.LAUNCH_STATSD_IN_PROCESS && !!JSON.parse(process.env.LAUNCH_STATSD_IN_PROCESS)){
    require('./statsd');
  }
}
catch(e) {
  if (e.name === "SyntaxError"){
    throw("Invalid value for process.env.LAUNCH_STATSD_IN_PROCESS.");
  }
  else{
    throw(e);
  }
}

var urls = require('./lib/urls');
var localStore = require('./lib/local-store');
var s3Store = require('./lib/s3-store');
var makeAPIPublisher = require('./lib/makeapi-publisher').create(process.env.MAKEAPI_URL, process.env.MAKEAPI_ID, process.env.MAKEAPI_SECRET);

// Cache fonts for 180 days.
var MAX_FONT_AGE_MS = 1000 * 60 * 60 * 24 * 180;

var LOCAL_STORE_BASE_PATH = __dirname + '/' + 'store';

// .env files aren't great at empty values.
process.env.ASSET_HOST = typeof process.env.ASSET_HOST === 'undefined' ? '' : process.env.ASSET_HOST;

var app = express();

app.engine('ejs', engine);

app.configure(function(){
  app.set('port', process.env.PORT || 3000);

  app.set('views', __dirname + '/views');
  app.set('view engine', 'ejs');

  app.use(express.logger(function(tokens, req, res) {
    if (res.statusCode >= 400) // or whatever you want logged
      return express.logger.dev(tokens, req, res);
    return null;
  }));

  app.use(express.bodyParser());
  app.use(express.cookieParser());

  app.use(express.cookieSession({
    key: "appmaker.sid",
    secret: process.env.COOKIE_SECRET,
    cookie: {
      maxAge: 60 * 60 * 24 * 31, // 31 days. Persona saves session data for 1 month
      secure: !!process.env.FORCE_SSL
    },
    proxy: true
  }));

  bundles.configure(app);

  // Setup locales with i18n
  app.use(i18n.middleware({
    supported_languages: ["*"],
    default_lang: "en-US",
    mappings: require("webmaker-locale-mapping"),
    translation_directory: path.resolve( __dirname, "locale" )
  }));

  app.use(express.favicon());

  app.use(function(req, res, next) {
    res.removeHeader("x-powered-by");
    next();
  });

  app.use(express.methodOverride());

  app.use(app.router);

  app.use(connectFonts.setup({
    fonts: [require('connect-fonts-sourcesanspro')],
    allow_origin: process.env.ASSET_HOST,
    ua: 'all',
    maxage: MAX_FONT_AGE_MS
  }));

  // enable cors for test relevant assets
  app.use("/test_assets/ceci/", cors());
  app.use("/test_assets/ceci/", express.static(path.join(__dirname, 'public', 'ceci')));
  app.use("/test_assets/vendor/", cors());
  app.use("/test_assets/vendor/", express.static(path.join(__dirname, 'public', 'vendor')));

  app.use(lessMiddleware({
    src: __dirname + '/public',
    compress: true
  }));

  app.use('/', cors());
  app.use('/', express.static(path.join(__dirname, 'public')));

  enableRedirects(app);
});

app.configure('development', function(){
  app.use(express.errorHandler());
  if (!process.env['PERSONA_AUDIENCE']){
    console.log("Setting PERSONA_AUDIENCE to be http://localhost:" + app.get('port'));
    process.env['PERSONA_AUDIENCE'] = 'http://localhost:' + app.get('port');
  }
});

require("express-persona")(app, {
  audience: process.env.PERSONA_AUDIENCE
});

var store;
var useSubdomains = false;

if (process.env.STORE === 's3') {
  if (!process.env.S3_KEY || process.env.S3_KEY === '') {
    console.warn('No S3 credentials. Reverting to local store.');
    store = localStore.init(LOCAL_STORE_BASE_PATH);
    app.use('/store', express.static(path.join(__dirname, 'store')));
  }
  else {
    store = s3Store.init(process.env.S3_KEY, process.env.S3_SECRET, process.env.S3_BUCKET);
    useSubdomains = true;
  }
}
else {
  store = localStore.init(LOCAL_STORE_BASE_PATH);
  app.use('/store', express.static(path.join(__dirname, 'store')));
}

var urlManager = new urls.URLManager(process.env.PUBLISH_HOST_PREFIX, process.env.PUBLISH_HOST, process.env.S3_OBJECT_PREFIX, useSubdomains);
routes = require('./routes')(
  store,
  __dirname + '/views',
  urlManager,
  require('./lib/mailer')(postmark),
  makeAPIPublisher
);

app.get('/', routes.index);

app.get('/about', routes.about);

app.get('/contribute', routes.contribute);

app.all('/designer', routes.designer);

app.get('/testappdesigner', routes.testappdesigner);

app.get('/testapp', routes.testapp);

// remix and publish email notification routes
app.get('/remix', routes.remix);
app.get('/notify', routes.notify);

//TODO: Security: https://github.com/mozilla-appmaker/appmaker/issues/602
app.get('/api/proxy-component-*', cors(), routes.proxy.gitHubComponent);
app.get('/component-*', cors(), routes.proxy.gitHubComponent);
app.get('/component/:org/:component/*', cors(), routes.proxy.component);

process.env.ARTIFICIAL_CORS_DELAY = parseInt(process.env.ARTIFICIAL_CORS_DELAY, 10);
// if ARTIFICIAL_CORS_DELAY is set, we use a different proxy route
if (("ARTIFICIAL_CORS_DELAY" in process.env) && (process.env.ARTIFICIAL_CORS_DELAY > 0)){
  // This route is only to test race conditions/loading issues with external resources
  app.get('/cors/:host/*', cors(), routes.proxy.delayedCors);
}
else{
  app.get('/cors/:host/*', cors(), routes.proxy.cors);
}

// This is a route that we use for client-side localization to return the JSON
// when we do the XHR request to this route.
app.get( "/strings/:lang?", middleware.crossOrigin, i18n.stringsRoute( "en-US" ) );

app.post('/api/publish', routes.publish.publish(app));

// routes for publishing and retrieving components
app.get('/api/component', routes.componentRegistry.components);
app.get('/api/component/:id', routes.componentRegistry.component);
app.post('/api/component', routes.componentRegistry.addComponent);
app.delete('/api/component/:id', routes.componentRegistry.deleteComponent);
app.get('/api/myapps', routes.my.apps);
app.post('/api/save_app', routes.my.saveApp);
app.delete('/api/delete_app', routes.my.deleteApp);
app.get('/api/app', routes.my.app);
app.post('/api/rename_app', routes.my.renameApp);
app.post('/api/update_app', routes.my.updateApp);

app.get('/api/componentlinks', routes.my.components);
app.post('/api/componentlinks', routes.my.learnComponent);
app.delete('/api/componentlinks', routes.my.forgetComponent);

app.get('/api/remix-proxy', routes.proxy.remix);

module.exports = app;

if (!module.parent) {
  // Load components from various sources
  components.load(function(components) {
    app.locals.components = components;
    localeBuild(components, ["en-US"], function(map) {
      i18n.addLocaleObject(map, function(err) {
        if(!err) {
          http.createServer(app).listen(app.get('port'), function(){
            console.log("Express server listening on port " + app.get('port'));
          });
        }
        else{
          console.log(err);
        }
      });
    });
  });
}

