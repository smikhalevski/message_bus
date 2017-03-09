(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(function () {
      return (root.MessageBus = factory());
    });
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MessageBus = factory();
  }
}(this, function () {
  'use strict';

  var originalMessageBus = window.MessageBus;
  var canUseDOM = window.document && window.document.createElement;
  var cacheBuster = Math.random() * 10000 | 0;

  if (canUseDOM) {
    var hiddenKey = 'hidden,webkitHidden,msHidden,mozHidden,hasFocus'
        .split(',')
        .find(function(key) {return key in window.document});
  }

  var document = window.document;
  var XHRImpl = window.XMLHttpRequest;

  // http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
  var callbacks, clientId, failCount, baseUrl;
  var me, started, stopped, longPoller, pollTimeout, paused, later, interval, chunkedBackoff;

  function uniqueId() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r, v;
      r = Math.random() * 16 | 0;
      v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  clientId = uniqueId();
  callbacks = [];
  interval = null;
  failCount = 0;
  baseUrl = "/";
  paused = false;
  later = [];
  chunkedBackoff = 0;
  var eventListener;

  var hasonprogress = false;//(new XMLHttpRequest()).onprogress === null;

  function allowChunked() {
    return me.enableChunkedEncoding && hasonprogress;
  }

  function shouldLongPoll() {
    return me.alwaysLongPoll || (canUseDOM && !window.document[hiddenKey]);
  }

  var totalAjaxFailures = 0;
  var totalAjaxCalls = 0;
  var lastAjax;

  var processMessages = function (messages) {
    var gotData = false;
    if (!messages) return false; // server unexpectedly closed connection

    for (var i = 0; i < messages.length; i++) {
      var message = messages[i];
      gotData = true;
      for (var j = 0; j < callbacks.length; j++) {
        var callback = callbacks[j];
        if (callback.channel === message.channel) {
          callback.last_id = message.message_id;
          try {
            callback.func(message.data, message.global_id, message.message_id);
          }
          catch (e) {
            if (console.log) {
              console.log("MESSAGE BUS FAIL: callback " + callback.channel + " caused exception " + e.message);
            }
          }
        }
        if (message.channel === "/__status") {
          if (message.data[callback.channel] !== undefined) {
            callback.last_id = message.data[callback.channel];
          }
        }
      }
    }

    return gotData;
  };

  var reqSuccess = function (messages) {
    failCount = 0;
    if (paused) {
      if (messages) {
        for (var i = 0; i < messages.length; i++) {
          later.push(messages[i]);
        }
      }
    } else {
      return processMessages(messages);
    }
    return false;
  };

  longPoller = function (poll, data) {
    var gotData = false;
    var aborted = false;
    lastAjax = new Date();
    totalAjaxCalls += 1;
    data.__seq = totalAjaxCalls;

    var longPoll = shouldLongPoll() && me.enableLongPolling;
    var chunked = longPoll && allowChunked();
    if (chunkedBackoff > 0) {
      chunkedBackoff--;
      chunked = false;
    }

    var headers = me.headers;
    var dataType = chunked ? "text" : "json";

    var handle_progress = function (payload, position) {

      var separator = "\r\n|\r\n";
      var endChunk = payload.indexOf(separator, position);

      if (endChunk === -1) {
        return position;
      }

      var chunk = payload.substring(position, endChunk);
      chunk = chunk.replace(/\r\n\|\|\r\n/g, separator);

      try {
        reqSuccess(JSON.parse(chunk));
      } catch (e) {
        if (console.log) {
          console.log("FAILED TO PARSE CHUNKED REPLY");
          console.log(data);
        }
      }

      return handle_progress(payload, endChunk + separator.length);
    }

    var disableChunked = function () {
      if (me.longPoll) {
        me.longPoll.abort();
        chunkedBackoff = 30;
      }
    };

    var setOnProgressListener = function (xhr) {
      var position = 0;
      // if it takes longer than 3000 ms to get first chunk, we have some proxy
      // this is messing with us, so just backoff from using chunked for now
      var chunkedTimeout = setTimeout(disableChunked, 3000);
      xhr.onprogress = function () {
        clearTimeout(chunkedTimeout);
        if (xhr.getResponseHeader('Content-Type') === 'application/json; charset=utf-8') {
          // not chunked we are sending json back
          chunked = false;
          return;
        }
        position = handle_progress(xhr.responseText, position);
      }
    };
    var req = me.ajax({
      url: me.baseUrl + "message-bus/" + me.clientId + "/poll" + (!longPoll ? "?dlp=t" : ""),
      data: data,
      cache: false,
      async: true,
      dataType: dataType,
      type: 'POST',
      headers: headers,
      messageBus: {
        chunked: chunked,
        onProgressListener: function (xhr) {
          var position = 0;
          // if it takes longer than 3000 ms to get first chunk, we have some proxy
          // this is messing with us, so just backoff from using chunked for now
          var chunkedTimeout = setTimeout(disableChunked, 3000);
          return xhr.onprogress = function () {
            clearTimeout(chunkedTimeout);
            if (xhr.getResponseHeader('Content-Type') === 'application/json; charset=utf-8') {
              chunked = false; // not chunked, we are sending json back
            } else {
              position = handle_progress(xhr.responseText, position);
            }
          }
        }
      },
      success: function (messages) {
        if (!chunked) {
          // we may have requested text so jQuery will not parse
          if (typeof(messages) === "string") {
            messages = JSON.parse(messages);
          }
          gotData = reqSuccess(messages);
        }
      },
      error: function (xhr, textStatus, err) {
        if (textStatus === "abort") {
          aborted = true;
        } else {
          failCount += 1;
          totalAjaxFailures += 1;
        }
      },
      complete: function () {
        var interval;
        try {
          if (gotData || aborted) {
            interval = 100;
          } else {
            interval = me.callbackInterval;
            if (failCount > 2) {
              interval = interval * failCount;
            } else if (!shouldLongPoll()) {
              interval = me.backgroundCallbackInterval;
            }
            if (interval > me.maxPollInterval) {
              interval = me.maxPollInterval;
            }

            interval -= (new Date() - lastAjax);

            if (interval < 100) {
              interval = 100;
            }
          }
        } catch (e) {
          if (console.log && e.message) {
            console.log("MESSAGE BUS FAIL: " + e.message);
          }
        }

        pollTimeout = setTimeout(function () {
          pollTimeout = null;
          poll();
        }, interval);
        me.longPoll = null;
      }
    });

    return req;
  };

  me = {
    enableChunkedEncoding: true,
    enableLongPolling: true,
    callbackInterval: 15000,
    backgroundCallbackInterval: 60000,
    maxPollInterval: 3 * 60 * 1000,
    callbacks: callbacks,
    clientId: clientId,
    alwaysLongPoll: false,
    baseUrl: baseUrl,
    headers: {},
    ajax: function (options) {
      var xhr = new XHRImpl();
      xhr.dataType = options.dataType;
      var url = options.url;
      if (!options.cache) {
        url += ((-1 == url.indexOf('?')) ? '?' : '&') + '_=' + (cacheBuster++)
      }
      xhr.open('POST', url);
      for (var name in options.headers) {
        xhr.setRequestHeader(name, options.headers[name]);
      }
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (options.messageBus.chunked) {
        options.messageBus.onProgressListener(xhr);
      }
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          var status = xhr.status;
          if (status >= 200 && status < 300 || status === 304) {
            options.success(xhr.responseText);
          } else {
            options.error(xhr, xhr.statusText);
          }
          options.complete();
        }
      }
      xhr.send(JSON.stringify(options.data));
      return xhr;
    },
    noConflict: function () {
      window.MessageBus = originalMessageBus;
      return this;
    },
    diagnostics: function () {
      console.log("Stopped: " + stopped + " Started: " + started);
      console.log("Current callbacks");
      console.log(callbacks);
      console.log("Total ajax calls: " + totalAjaxCalls + " Recent failure count: " + failCount + " Total failures: " + totalAjaxFailures);
      console.log("Last ajax call: " + (new Date() - lastAjax) / 1000 + " seconds ago");
    },

    pause: function () {
      paused = true;
    },

    resume: function () {
      paused = false;
      processMessages(later);
      later = [];
    },

    stop: function () {
      stopped = true;
      started = false;
    },

    // Start polling
    start: function () {
      var delayPollTimeout;

      if (started) return;
      started = true;
      stopped = false;

      function poll() {
        var data;

        if (stopped) {
          return;
        }

        if (callbacks.length === 0) {
          if (!delayPollTimeout) {
            delayPollTimeout = setTimeout(function () {
              delayPollTimeout = null;
              poll();
            }, 500);
          }
          return;
        }

        data = {};
        for (var i = 0; i < callbacks.length; i++) {
          data[callbacks[i].channel] = callbacks[i].last_id;
        }

        me.longPoll = longPoller(poll, data);
      }

      if (canUseDOM) {
        if (eventListener) {
          removeEventListener('visibilitychange', eventListener);
        }
        eventListener = function () {
          if (!document[hiddenKey] && !me.longPoll && pollTimeout) {
            clearTimeout(pollTimeout);
            pollTimeout = null;
            poll();
          }
        };
        addEventListener('visibilitychange', eventListener);
      }

      poll();
    },

    status: function () {
      if (paused) {
        return "paused";
      } else if (started) {
        return "started";
      } else if (stopped) {
        return "stopped";
      } else {
        throw "Cannot determine current status";
      }
    },

    // Subscribe to a channel
    subscribe: function (channel, func, lastId) {

      if (!started && !stopped) {
        me.start();
      }

      if (typeof(lastId) !== "number" || lastId < -1) {
        lastId = -1;
      }
      callbacks.push({
        channel: channel,
        func: func,
        last_id: lastId
      });
      if (me.longPoll) {
        me.longPoll.abort();
      }

      return func;
    },

    // Unsubscribe from a channel
    unsubscribe: function (channel, func) {
      // TODO allow for globbing in the middle of a channel name
      // like /something/*/something
      // at the moment we only support globbing /something/*
      var glob;
      if (channel.indexOf("*", channel.length - 1) !== -1) {
        channel = channel.substr(0, channel.length - 1);
        glob = true;
      }

      var removed = false;

      for (var i = callbacks.length - 1; i >= 0; i--) {

        var callback = callbacks[i];
        var keep;

        if (glob) {
          keep = callback.channel.substr(0, channel.length) !== channel;
        } else {
          keep = callback.channel !== channel;
        }

        if (!keep && func && callback.func !== func) {
          keep = true;
        }

        if (!keep) {
          callbacks.splice(i, 1);
          removed = true;
        }
      }

      if (removed && me.longPoll) {
        me.longPoll.abort();
      }

      return removed;
    }
  };
  return me;
}));
