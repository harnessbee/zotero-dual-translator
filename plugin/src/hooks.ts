import { createZToolkit } from "./utils/ztoolkit";
import { DualTranslateReader } from "./modules/dualTranslate";

const dualTranslateReader = new DualTranslateReader();
let prefsRegistered = false;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  addon.data.ztoolkit = createZToolkit();
  addon.api = { dualTranslateReader };
  registerPrefsPane();
  await dualTranslateReader.startup();

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(_win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
}

async function onMainWindowUnload(_win: Window): Promise<void> {}

function onShutdown(): void {
  dualTranslateReader.shutdown();
  unregisterPrefsPane();
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this funcion clear.
 */
async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(
  _type: string,
  _data: { [key: string]: any },
) {}

function onShortcuts(_type: string) {}

function onDialogEvents(_type: string) {}

function registerPrefsPane() {
  if (prefsRegistered) {
    return;
  }
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: `${rootURI}content/preferences.xhtml`,
    label: addon.data.config.addonName,
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
  prefsRegistered = true;
}

function unregisterPrefsPane() {
  if (!prefsRegistered) {
    return;
  }
  Zotero.PreferencePanes.unregister(addon.data.config.addonID);
  prefsRegistered = false;
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
