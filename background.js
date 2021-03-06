/* global browser */

const DEFAULT_VIEWER_URL = 'https://perf-html.io';

const tabToConnectionMap = new Map();

function adjustState(newState) {
  // Deep clone the object, since this can be called through popup.html,
  // which can be unloaded thus leaving this object dead.
  newState = JSON.parse(JSON.stringify(newState));
  Object.assign(window.profilerState, newState);
  browser.storage.local.set({ profilerState: window.profilerState });
}

function makeProfileAvailableToTab(profile, port) {
  port.postMessage({ type: 'ProfilerConnectToPage', payload: profile });

  port.onMessage.addListener(async message => {
    if (message.type === 'ProfilerGetSymbolTable') {
      const { debugName, breakpadId } = message;
      try {
        const [
          addresses,
          index,
          buffer,
        ] = await browser.geckoProfiler.getSymbols(debugName, breakpadId);

        port.postMessage({
          type: 'ProfilerGetSymbolTableReply',
          status: 'success',
          result: [addresses, index, buffer],
          debugName,
          breakpadId,
        });
      } catch (e) {
        port.postMessage({
          type: 'ProfilerGetSymbolTableReply',
          status: 'error',
          error: `${e}`,
          debugName,
          breakpadId,
        });
      }
    }
  });
}

async function createAndWaitForTab(url) {
  const tabPromise = browser.tabs.create({
    active: true,
    url,
  });

  return tabPromise;
}

async function listenOnceForConnect(name) {
  window.connectDeferred[name] = {};
  window.connectDeferred[name].promise = new Promise((resolve, reject) => {
    Object.assign(window.connectDeferred[name], { resolve, reject });
  });
  return await window.connectDeferred[name].promise;
}

function getProfilePreferablyAsArrayBuffer() {
  // This is a compatibility wrapper for Firefox builds from before 1362800
  // landed. We can remove it once Nightly switches to 56.
  if ('getProfileAsArrayBuffer' in browser.geckoProfiler) {
    return browser.geckoProfiler.getProfileAsArrayBuffer();
  }
  return browser.geckoProfiler.getProfile();
}

async function captureProfile() {
  // Pause profiler before we collect the profile, so that we don't capture
  // more samples while the parent process waits for subprocess profiles.
  await browser.geckoProfiler.pause().catch(() => {});

  const profilePromise = getProfilePreferablyAsArrayBuffer().catch(
    e => (console.error(e), {})
  );

  const { profileViewerURL } = await browser.storage.local.get({
    profileViewerURL: DEFAULT_VIEWER_URL,
  });
  const tabOpenPromise = createAndWaitForTab(profileViewerURL + '/from-addon');

  try {
    const [profile, tab] = await Promise.all([profilePromise, tabOpenPromise]);

    const connection = tabToConnectionMap.get(tab.id);

    if (connection) {
      // If, for instance, it takes a long time to load the profile,
      // then our onDOMContentLoaded handler and our runtime.onConnect handler
      // have already connected to the page. All we need to do then is
      // provide the profile.
      makeProfileAvailableToTab(profile, connection.port);
    } else {
      // If our onDOMContentLoaded handler and our runtime.onConnect handler
      // haven't connected to the page, set this so that they'll have a
      // profile they can provide once they do.
      tabToConnectionMap.set(tab.id, { profile });
    }
  } catch (e) {
    console.error(e);
    // const { tab } = await tabOpenPromise;
    // TODO data URL doesn't seem to be working. Permissions issue?
    // await browser.tabs.update(tab.id, { url: `data:text/html,${encodeURIComponent(e.toString)}` });
  }

  try {
    await browser.geckoProfiler.resume();
  } catch (e) {
    console.error(e);
  }
}

async function startProfiler() {
  const settings = window.profilerState;
  const threads = settings.threads.split(',');
  const enabledFeatures = Object.keys(settings.features).filter(
    f => settings.features[f]
  );
  enabledFeatures.push('leaf');
  if (threads.length > 0) {
    enabledFeatures.push('threads');
  }
  const options = {
    bufferSize: settings.buffersize,
    interval: settings.interval,
    features: enabledFeatures,
    threads,
  };
  await browser.geckoProfiler.start(options);
}

async function stopProfiler() {
  await browser.geckoProfiler.stop();
}

/* exported restartProfiler */
async function restartProfiler() {
  await stopProfiler();
  await startProfiler();
}

(async () => {
  window.profilerState = (await browser.storage.local.get(
    'profilerState'
  )).profilerState;

  if (!window.profilerState) {
    window.profilerState = {};
    adjustState({
      isRunning: false,
      settingsOpen: false,
      buffersize: 1000000,
      interval: 1,
      features: {
        js: true,
        stackwalk: true,
        tasktracer: false,
      },
      threads: 'GeckoMain,Compositor',
      reportUrl: 'https://perf-html.io/from-addon/',
    });
  }

  browser.geckoProfiler.onRunning.addListener(isRunning => {
    adjustState({ isRunning });
    browser.browserAction.setIcon({
      path: `icons/toolbar_${isRunning ? 'on' : 'off'}.png`,
    });
    for (const popup of browser.extension.getViews({ type: 'popup' })) {
      popup.renderState(window.profilerState);
    }
  });

  browser.commands.onCommand.addListener(command => {
    if (command === 'ToggleProfiler') {
      if (window.profilerState.isRunning) {
        stopProfiler();
      } else {
        startProfiler();
      }
    } else if (command === 'CaptureProfile') {
      if (window.profilerState.isRunning) {
        captureProfile();
      }
    }
  });

  browser.runtime.onConnect.addListener(port => {
    const tabId = port.sender.tab.id;
    const connection = tabToConnectionMap.get(tabId);
    if (connection && connection.profile) {
      makeProfileAvailableToTab(connection.profile, port);
    } else {
      tabToConnectionMap.set(tabId, { port });
    }
  });

  browser.tabs.onRemoved.addListener(tabId => {
    tabToConnectionMap.delete(tabId);
  });

  browser.webNavigation.onDOMContentLoaded.addListener(
    async ({ tabId, url }) => {
      const { profileViewerURL } = await browser.storage.local.get({
        profileViewerURL: DEFAULT_VIEWER_URL,
      });

      if (url.startsWith(profileViewerURL)) {
        const tab = await browser.tabs.get(tabId);
        browser.tabs.executeScript(tab.id, { file: 'content.js' });
      } else {
        // As soon as we navigate away from the profile report, clean
        // this up so we don't leak it.
        tabToConnectionMap.delete(tabId);
      }
    }
  );
})();
