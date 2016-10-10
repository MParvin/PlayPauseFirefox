//     This file is part of Play/Pause extension for Mozilla Firefox
//     https://github.com/DanielKamkha/PlayPauseFirefox
//     (c) 2015-2016 Daniel Kamkha
//     Play/Pause is free software distributed under the terms of the MIT license.

/* jshint esversion: 6 */
/* jshint node: true */

// TODO: Twitch front page observer
// TODO: iHeartRadio "buffering" class as playing

(function() {
  "use strict";

  const { viewFor } = require("sdk/view/core");
  const { getTabId } = require("sdk/tabs/utils");
  const simplePrefs = require("sdk/simple-prefs");
  const _ = require("sdk/l10n").get;
  const getTab = require("sdk/tabs/utils");
  const urlSDK = require("sdk/url");
  const self = require("sdk/self");

  const playSymbol = "▶";
  const pauseSymbol = "❚❚";
  const playSymbolAlt = "▶︎";
  const playSymbolLarge = "►";
  const stopSymbol = "◼";
  const stripSymbols = [playSymbol, playSymbolAlt, playSymbolLarge, stopSymbol];

  const fixTabAttributes = ["pinned", "selected", "visuallyselected"];
  const fixSoundAttributes = ["soundplaying", "muted"];

  const experimentalSupport = [/.*allmusic\.com.*/, /.*facebook\.com.*/, /.*inoreader\.com.*/];

  let workers = {}; // workers cache
  let pageMod = null;
  let hotkeyToggleAllTabs = null;
  let hotkeySmartPause = null;
  let smartPauseTabs = null;

  function getPlayPauseElement(xulTab) {
    return xulTab.ownerDocument.getAnonymousElementByAttribute(xulTab, "anonid", "play-pause");
  }

  function getTabLabelElement(xulTab) {
    return xulTab.ownerDocument.getAnonymousElementByAttribute(xulTab, "class", "tab-text tab-label");
  }

  function getPlayPauseFaviconElement(xulTab) {
    return xulTab.ownerDocument.getAnonymousElementByAttribute(xulTab, "class", "tab-icon-image");
  }
  function getDomainSiteName(xulTab) {
    var host = urlSDK.URL(getTab.getTabURL(getTab.getTabForId(getTabId(xulTab)))).host.split(".");
    return [host[host.length - 2], host[host.length - 1]];
  }

  function addPlayPauseSymbol(xulTab) {
    let playPause = getPlayPauseElement(xulTab);

    let playPauseFavicon = getPlayPauseFaviconElement(xulTab);
    let indicatorMode = simplePrefs.prefs["indicator-mode"];
    let faviconSites = simplePrefs.prefs["favicon-sites"];
    let [domainSiteName, domainSiteEx] = getDomainSiteName(xulTab);

    if (!playPause) {
      let chromeDocument = xulTab.ownerDocument;
      let worker = workers[getTabId(xulTab)];

      playPause = chromeDocument.createElement("div");
      playPause.setAttribute("anonid", "play-pause");
      if (indicatorMode === 0 || indicatorMode === 2 || (faviconSites.indexOf(domainSiteName + "." + domainSiteEx) === -1 && faviconSites !== "*")) {
        playPause.style.pointerEvents = "all";
        playPause.style.cursor = "pointer";
        playPause.style.marginRight = "0.25em";
      }

      let tabMixPlusHack = !!xulTab.onMouseCommand;
      if (tabMixPlusHack) {
        let overPlayPause = false;
        playPause.addEventListener("mouseover", function () {
          overPlayPause = true;
        }, true);
        playPause.addEventListener("mouseout", function () {
          overPlayPause = false;
        }, true);

        playPause.cachedOnMouseCommand = xulTab.onMouseCommand;
        xulTab.onMouseCommand = function(event) {
          if (overPlayPause) {
            // Make sure it's a single LMB click with no modifiers.
            if (event.button === 0 && event.detail === 1 &&
                !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              worker.port.emit("toggle");
              event.stopPropagation();
              return;
            }
          }
          return playPause.cachedOnMouseCommand.call(this, event);
        };
      } else {
        playPause.addEventListener("mousedown", function (event) {
          // Make sure it's a single LMB click with no modifiers.
          if (event.button === 0 && event.detail === 1 &&
              !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            worker.port.emit("toggle");
            event.stopPropagation();
          }
        }, true);
      }

      if (indicatorMode > 0) {
        playPauseFavicon.style.cursor = "pointer";
        playPauseFavicon.style.pointerEvents = "all";
        playPauseFavicon.addEventListener("mousedown", function(event) {
          // Make sure it's a single LMB click with no modifiers.
          if (event.button === 0 && event.detail === 1 &&
            !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            worker.port.emit("toggle");
            event.stopPropagation();
          }
        }, true);
      }

      let tabContent = chromeDocument.getAnonymousElementByAttribute(xulTab, "class", "tab-content");
      let tabLabel = getTabLabelElement(xulTab);
      if (tabLabel) {
        tabContent.insertBefore(playPause, tabLabel);
      } else {
        tabContent.appendChild(playPause);
      }

      worker.port.emit("query");
    }
  }

  function removePlayPauseSymbol(xulTab) {
    let playPause = getPlayPauseElement(xulTab);
    let playPauseFavicon = getPlayPauseFaviconElement(xulTab);
    if (!!playPause) {
      if (!!playPause.cachedOnMouseCommand) {
        xulTab.onMouseCommand = playPause.cachedOnMouseCommand;
      }
      playPause.remove();
    }
    getTabLabelElement(xulTab).style.color = "#000000";
    if (!!playPauseFavicon) { // Remove styles of favicon
      playPauseFavicon.style.cursor = "default";
      playPauseFavicon.style.pointerEvents = "none";
      let faviconSrc = playPauseFavicon.getAttribute("faviconSrc");
      if (faviconSrc) playPauseFavicon.src = faviconSrc;
    }
  }

  function stripSymbolsFromLabel(label) {
    let tokenArray = label.split(" ");
    for (let idx = 0; idx < tokenArray.length; idx++) {
      if (stripSymbols.indexOf(tokenArray[idx]) === -1) {
        return tokenArray.slice(idx).join(" ");
      }
    }
    return label;
  }

  function setTabLabelValueForTab(xulTab, value, shouldStrip) {
    let tabLabel = getTabLabelElement(xulTab);
    if (tabLabel) {
      if (shouldStrip) {
        value = stripSymbolsFromLabel(value);
      }
      tabLabel.value = value;
    }
  }

  function tabMoveHandler(event) {
    let xulTab = event.target;
    setTabLabelValueForTab(xulTab, xulTab.label, true);
    addPlayPauseSymbol(xulTab);
  }

  function propagateAttributes(fromElem, toElem, attrArray) {
    attrArray.forEach(function(attribute) {
      if (fromElem.getAttribute(attribute)) {
        toElem.setAttribute(attribute, "true");
      } else {
        toElem.removeAttribute(attribute);
      }
    });
  }

  function tabModifiedHandler(event) {
    let xulTab = event.target;
    let chromeDocument = xulTab.ownerDocument;

    setTabLabelValueForTab(xulTab, xulTab.label, true);

    let closeButton = chromeDocument.getAnonymousElementByAttribute(xulTab, "anonid", "close-button");
    if (!closeButton) {
      // Check if "Tab Mix Plus" Close button is present.
      closeButton = chromeDocument.getAnonymousElementByAttribute(xulTab, "anonid", "tmp-close-button");
    }
    if (closeButton) {
      propagateAttributes(xulTab, closeButton, fixTabAttributes);
    }

    let soundButton = chromeDocument.getAnonymousElementByAttribute(xulTab, "anonid", "soundplaying-icon");
    if (soundButton) {
      propagateAttributes(soundButton.previousSibling, soundButton, fixSoundAttributes);
      soundButton.removeAttribute("selected");
    }
  }

  function addEventBindings(xulTab) {
    xulTab.addEventListener("TabMove", tabMoveHandler);
    xulTab.addEventListener("TabPinned", tabModifiedHandler);
    xulTab.addEventListener("TabUnpinned", tabModifiedHandler);
    xulTab.addEventListener("TabAttrModified", tabModifiedHandler);
  }

  function removeEventBindings(xulTab) {
    xulTab.removeEventListener("TabMove", tabMoveHandler);
    xulTab.removeEventListener("TabPinned", tabModifiedHandler);
    xulTab.removeEventListener("TabUnpinned", tabModifiedHandler);
    xulTab.removeEventListener("TabAttrModified", tabModifiedHandler);
  }

  function setSymbolGlyph(xulTab, paused) {
    let playPause = getPlayPauseElement(xulTab);

    let playPauseFavicon = getPlayPauseFaviconElement(xulTab);
    let indicatorMode = simplePrefs.prefs["indicator-mode"];
    let faviconSites = simplePrefs.prefs["favicon-sites"];
    let colorMode = simplePrefs.prefs["color-mode"];
    let [domainSiteName, domainSiteEx] = getDomainSiteName(xulTab);
    let faviconAvailable = (domainSiteName === "youtube" || domainSiteName === "twitch" || domainSiteName === "koreus");
    if (faviconSites.indexOf(domainSiteName + "." + domainSiteEx) === -1 && faviconSites !== "*") indicatorMode = 0;

    if (playPause) {
      let invertIndicator = simplePrefs.prefs["invert-indicator"];
      if (paused === undefined) {
        paused = (playPause.textContent === pauseSymbol) === invertIndicator;
      }
      playPause.textContent = (paused !== invertIndicator) ? pauseSymbol : playSymbol;

      if (faviconAvailable) {
        if (indicatorMode > 0) {
          let pauseURL = self.data.url("images/" + domainSiteName + "-pause.png");
          let playURL = self.data.url("images/" + domainSiteName + "-play.png");
          if (playPauseFavicon.src.startsWith('http')) playPauseFavicon.setAttribute("faviconSrc", playPauseFavicon.src); 
          playPauseFavicon.src = (paused !== invertIndicator) ? pauseURL : playURL;
        } else if (indicatorMode === 0) {
          let faviconSrc = playPauseFavicon.getAttribute("faviconSrc");
          if (faviconSrc) playPauseFavicon.src = faviconSrc;
        }
      } else {
        colorMode = false;
      }
      if (indicatorMode === 1) playPause.style.display = "none";
      if (!colorMode) getTabLabelElement(xulTab).style.color = paused ? simplePrefs.prefs["color-pause-tab"] : simplePrefs.prefs["color-play-tab"];
    }
  }

  function toggleAllTabs() {
    for (let id in workers) {
      workers[id].port.emit("toggle");
    }
  }

  function smartPause() {
    // Collect ids of playing tabs
    let invertIndicator = simplePrefs.prefs["invert-indicator"];
    let playingTabs = [];
    for (let id in workers) {
      let playPause = getPlayPauseElement(viewFor(workers[id].tab));
      if (!!playPause && ((playPause.textContent === pauseSymbol) === invertIndicator)) {
        playingTabs.push(id);
      }
    }

    // If there are playing tabs, remember the ids
    if (playingTabs.length > 0) {
      smartPauseTabs = playingTabs;
    }

    // If there are remembered ids, toggle them
    if (!!smartPauseTabs && (smartPauseTabs.length > 0)) {
      for (let id of smartPauseTabs) {
        let worker = workers[id];
        if (worker) {
          worker.port.emit("toggle");
        }
      }
    }
  }

  function startListening(worker) {
    let sdkTab = worker.tab;
    if (!sdkTab) {
      worker.destroy();
      return;
    }
    let xulTab = viewFor(sdkTab);
    let id = sdkTab.id;

    workers[id] = worker;

    worker.port.once("options", function () {
      worker.port.emit("options", {
        doEmbeds: simplePrefs.prefs["do-embeds"]
      });
    });
    worker.port.once("init", function () {
      setTabLabelValueForTab(xulTab, xulTab.label, true);
      addPlayPauseSymbol(xulTab);
      addEventBindings(xulTab);
      worker.port.emit("query");
    });
    worker.port.on("stateChanged", function (playerId) {
      worker.port.emit("query", playerId);
    });
    worker.port.on("paused", setSymbolGlyph.bind(null, xulTab));
    worker.on("detach", function () {
      if (xulTab) {
        removeEventBindings(xulTab);
        removePlayPauseSymbol(xulTab);
        try {
          setTabLabelValueForTab(xulTab, sdkTab.title, false);
        } catch (e) {
          // should happen for tab/browser closing; do nothing
        }
        xulTab = null;
      }
      delete workers[id];
    });
    worker.port.once("disable", function () {
      worker.destroy();
      delete workers[id];
    });
  }

  function resetPageMod() {
    if (pageMod) {
      pageMod.destroy();
    }

    pageMod = require("sdk/page-mod").PageMod({
      include: "*", // Match everything
      exclude: experimentalSupport,
      attachTo: ["existing", "top"],
      contentScriptFile: [
        "./play-pause-base.js",
        "./buttonless-html5-player.js",
        "./multibutton-html5-player.js",
        "./single-button-generic-player.js",
        "./two-button-generic-player.js",
        "./direct-access-flash-player.js",
        "./play-pause-detect.js",
        "./content-script.js"
      ],
      onAttach: startListening
    });
  }

  function resetIndicators() {
    for (let id in workers) {
      setSymbolGlyph(viewFor(workers[id].tab));
    }
  }

  function chooseHotkey() {
    const sdkPanel = require('sdk/panel').Panel;
    let panel = sdkPanel({
      width: 380,
      height: 280,
      contentURL: ('./preferences/panel.html'),
      contentScriptFile: ('./preferences/panel.js')
    });
    panel.port.emit('panel', {
      title: _("chooseHotkeyTitle"),
      toggleAllTabs: simplePrefs.prefs["hotkey-toggleAllTabs"],
      smartPause: simplePrefs.prefs["hotkey-smartPause"],
    });

    panel.port.on('toggleAllTabs', (msg) => {
      simplePrefs.prefs["hotkey-toggleAllTabs"] = msg;
      resetHotkey();
    });
    panel.port.on('smartPause', (msg) => {
      simplePrefs.prefs["hotkey-smartPause"] = msg;
      resetHotkey();
    });
    panel.show();
  }

  function resetHotkey() {
    const hotkeys = require("sdk/hotkeys").Hotkey;
    if (hotkeyToggleAllTabs) {
      hotkeyToggleAllTabs.destroy();
      hotkeyToggleAllTabs = null;
    }
    if (hotkeySmartPause) {
      hotkeySmartPause.destroy();
      hotkeySmartPause = null;
    }

    var comboToggleAllTabs = simplePrefs.prefs["hotkey-toggleAllTabs"];
    if (comboToggleAllTabs !== "") {
      hotkeyToggleAllTabs = hotkeys({
        combo: comboToggleAllTabs,
        onPress: toggleAllTabs
      });
    }
    var comboSmartPause = simplePrefs.prefs["hotkey-smartPause"];
    if (comboSmartPause !== "") {
      hotkeySmartPause = hotkeys({
        combo: comboSmartPause,
        onPress: smartPause
      });
    }
  }

  function playPauseButton() {
    const actionButton = require("sdk/ui").ActionButton;
    actionButton({
      id: "buttonToggleAllTabs",
      label: _("buttonTitleToggleAllTabs"),
      icon: "./images/toggleAllTabs.png",
      onClick: toggleAllTabs
    });
    actionButton({
      id: "buttonSmartPause",
      label: _("buttonTitleSmartPause"),
      icon: "./images/smartPause.png",
      onClick: smartPause
    });
  }

  exports.main = function() {
    simplePrefs.on("do-embeds", resetPageMod);
    simplePrefs.on("invert-indicator", resetIndicators);
    simplePrefs.on("choose-hotkey", chooseHotkey);
    simplePrefs.on("indicator-mode", resetPageMod);
    simplePrefs.on("color-play-tab", resetPageMod);
    simplePrefs.on("color-pause-tab", resetPageMod);
    simplePrefs.on("color-mode", resetPageMod);
    simplePrefs.on("favicon-sites", resetPageMod);
    resetPageMod();
    resetHotkey();
    playPauseButton();
  };
})();
