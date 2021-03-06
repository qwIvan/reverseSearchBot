const fetch = require('node-fetch');
const socksProxyAgent = require('socks-proxy-agent');
const httpsProxyAgent = require('https-proxy-agent');
// var proxyLists = require('proxy-lists');
var LRU = require("lru-cache");
var cache = LRU({ max: 50, maxAge: 1000 * 60 * 60 * 24 });
const cheerio = require('cheerio');

var SETTINGS = require("../settings/settings.js");
var urlbase = SETTINGS.url;
var MESSAGE = SETTINGS.msg;
var parseSauceNao = require("./parseSauceNao.js");
var reportToOwner = require("./reportToOwner.js");
var tools = require("../tools/tools.js");
const analytics = require('./analytics.js');
var idButtonName = SETTINGS.id_buttonName;
var proxy = {idx:0, lastReqTime:0, agent:null, 
  torAgent: new socksProxyAgent("socks5://127.0.0.1:9100")};
var bot;

var changeProxy = () => {
  const now = (new Date).getTime();
  if (now - proxy.lastReqTime < 10*60*1000)
   //allow only one proxy req within x mins
    return;
  proxy.idx = (proxy.idx + 1 ) % SETTINGS.private.socksProxyUrls.length;
  var url = SETTINGS.private.socksProxyUrls[proxy.idx];
  if (url){
    if (url.startsWith('http'))
      proxy.agent = new httpsProxyAgent(url);
    else if (url.startsWith('socks'))
      proxy.agent = new socksProxyAgent(url);
  }
  else
    proxy.agent = null;
  proxy.lastReqTime = now;
/*
  const gettingProxies = proxyLists.getProxies(urlbase.proxyListParams);

  gettingProxies.on('data', function(proxies) {
    if (proxies && proxies.length && proxy.agent == null){
      
      const res = proxies[0];
      console.dir(res);
      const protocol = res.protocols[0];
      const url = protocol + "://" +res.ipAddress+ ":" + res.port;
      if (protocol == 'http'){
        proxy.agent = new httpsProxyAgent(url);
      } else if (protocol.startsWith('socks')){
        proxy.agent = new socksProxyAgent(url);
      } //else stay null
      console.log("proxy set to " + url);
    }
    
  });
*/
  var options = {};
  options.agent = proxy.torAgent;

  fetch(urlbase.proxyList+ tools.json2query(urlbase.proxyListParams), options)
    .then(res => res.json())
    .then(res => {
      if (res.ip && res.port){
        var protocol = res.protocol || res.type;
        url = protocol + "://" +res.ip+ ":" + res.port;
        if (protocol == 'http'){
          proxy.agent = new httpsProxyAgent(url);
        } else if (protocol.startsWith('socks')){
          proxy.agent = new socksProxyAgent(url);
        } //else stay null
        console.log("proxy set to " + url);
      } else
        console.dir(res);
    }
  );
};

var myFetch = (url, editMsg, options) => {
  var hit = cache.get(url);

  if (hit && editMsg && editMsg.origFrom){
    analytics.track(editMsg.origFrom, "cache_hit");
    return Promise.resolve(hit);
  }

  if (options == null)
    options = {};
  if (url.indexOf("saucenao") > -1) //saucenao always goes through tor
    options.agent = proxy.torAgent;
  else
    options.agent = proxy.agent;

  return fetch(url, options).then((res) => {
    if (res.status >= 200 && res.status < 300) {
      var txt = res.text();
          cache.set(url, txt);
          return txt;
      // return Promise.resolve(txt)
    } else {
      var error = new Error(res.statusText || res.status);
      error.response = res;
      if (options.params && options.params.url)
        error.url = options.params.url;
      return Promise.reject(error);
    }
  })
};

var getTineyeButtons = (pic, page, shareId) => 
  [
    bot.inlineButton(idButtonName.picLink, {
      url: pic
    }),
    bot.inlineButton(idButtonName.pageLink, {
      url: page
    }),
    bot.inlineButton(idButtonName.share, {
      inline: "te|" + shareId
    })
  ];
module.exports = {
  fetchTineye: (url, editMsg) => {
    var params = {url: url, sort: 'size', order: 'desc'};
    uurl = urlbase.tinEye + tools.json2query(params);
    
    return myFetch(uurl, editMsg,
      {headers:
        {
          "User-Agent": SETTINGS.userAgents[
            parseInt(Math.random()*SETTINGS.userAgents.length)
          ],
        },
        params: params
      }
    );
  },
  getTineyeButtons: getTineyeButtons,
  parseSauceNao: (response, editMsg) => parseSauceNao(response, bot, editMsg),
  setBot: botp => {
    bot = botp;
    changeProxy();
  },
  parseTineye: (res, editMsg) => {
    console.log("get tineye completed");

    var tmp = res;
    var start = tmp.indexOf('match-row"');
    start = tmp.indexOf('<div class="match"', start);
    if (start == -1){
      
      if (tmp.indexOf("/faq#search_limit")>-1){
        reportToOwner.reportLimitReached("tineye", bot);
        changeProxy();
      } else 
        console.log("not found");
      return Promise.reject(new Error(MESSAGE.zeroResult));
    }
    //TODO: if URL, load/head it, check if mime=pic types, say invalid url if not.
    tmp = tmp.substring( start, tmp.indexOf('</div>', start)+6);
    //console.dir(tmp);
    return new Promise ( (resolve, reject) => {
      const $ =cheerio.load(tmp);

      var siteName = $("h4").text().trim(), 
        imgName = $("p > a").first().text(),
        highResUrl = $("p > a").attr('href'), 
        page = $("p > span").next().attr('href');
      console.log("tineyeUrls", imgName , highResUrl , page);
      //"collections"
      if (!page)
        page = highResUrl;
      var displayText = "Image source was found at: <a href=\"" + highResUrl + "\">" + imgName 
		    + "</a> from <a href=\"" + page + "\">" + siteName + "</a>\n";
      var shareId = editMsg.fileId || editMsg.url;
      var bList = getTineyeButtons(highResUrl, page, shareId);
      if (!editMsg.inline_message_id && editMsg.searched != 'sn')
        bList.splice(2, 0, bot.inlineButton(idButtonName.searchSauceNao, {
            callback: "sn|"+ editMsg.origFrom.id //+"|" + shareId
          }));
      var markup = bot.inlineKeyboard(tools.buttonsGridify(bList));

      analytics.track(editMsg.origFrom, "sauce_found_tineye");
      resolve([displayText, markup]);
    });
  },
  fetchSauceNao: (url, editMsg) => {
    var params = urlbase.sauceNaoParams;
    params.url = url;
    // params.api_key = SETTINGS.private.SNKey;
    uurl = urlbase.sauceNao + tools.json2query(params);
    
    return myFetch(uurl, editMsg, { params: params });
  },
  errInFetch: err => {
    console.log("errInFetch");

    if (err.name == "FetchError" || err.status != 200)
      changeProxy();
    reportToOwner.reportError(err, bot);
    if (err.response) {
      // The request was made, but the server responded with a status code
      // that falls out of the range of 2xx
      console.log("-----error.status is", err.response.status);
      console.log("-----error.headers is", err.response.headers);
      // console.log("-----error.text is", err.response.text);
      if (err.response.status && err.response.status == 429) {
        reportToOwner.reportLimitReached("sauceNao", bot);
        return [tools.getGoogleSearch(MESSAGE.reachLimitation, err.url)];
      } else
        return ["<b>Error:</b> " + err.name +" \n\nPlease try again after some time..."];
    } else {
      console.dir(err);

      console.log('-----error', err.message);
      return ["<b>Error:</b> " + err.name +" \n\nPlease try again after some time..."];
    }
    
  }
};
