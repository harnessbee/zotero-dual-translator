import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";

type LayoutBlock = {
  id: string;
  page: number;
  bbox: number[];
  text: string;
  translated_text?: string | null;
  font_size_hint?: number | null;
  type?: string;
  docling_label?: string;
  docling_item_type?: string;
  content_layer?: string;
  content_kind?: string;
  render_mode?: "translate" | "passthrough";
};

type PageLayout = {
  page: number;
  width: number;
  height: number;
  blocks: LayoutBlock[];
};

type TranslateResponse = {
  doc_id: string;
  requested_page: number;
  pages: PageLayout[];
  status: "ok" | "unsupported";
  reason?: string | null;
};

type PrefSnapshot = {
  serviceURL: string;
  targetLang: string;
  radius: number;
  autoPrefetch: boolean;
  fontScale: number;
  lineSpacing: number;
};

type SplitRestoreState = {
  previousType: "horizontal" | "vertical" | null;
  previousSize: string | null;
  changedByPlugin: boolean;
};

type ReaderChrome = {
  host: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  pageBadge: HTMLElement;
  nearbyRail: HTMLElement;
  refreshButton: HTMLButtonElement;
  fetchNearbyButton: HTMLButtonElement;
  fontDownButton: HTMLButtonElement;
  fontUpButton: HTMLButtonElement;
  fontValue: HTMLElement;
  lineDownButton: HTMLButtonElement;
  lineUpButton: HTMLButtonElement;
  lineValue: HTMLElement;
  panelToggleButton: HTMLButtonElement;
};

type ReaderState = {
  reader: _ZoteroTypes.ReaderInstance<"pdf">;
  primaryDoc: Document;
  secondaryDoc: Document;
  primaryApp: _ZoteroTypes.Reader.PDFViewerApplication;
  secondaryApp: _ZoteroTypes.Reader.PDFViewerApplication;
  chrome: ReaderChrome;
  currentPage: number;
  totalPages: number;
  requestSerial: number;
  pageCache: Map<number, PageLayout>;
  fetchedKeys: Set<string>;
  inflightKeys: Set<string>;
  cleanupFns: Array<() => void>;
  splitRestore: SplitRestoreState;
  settingsKey: string;
  panelCollapsed: boolean;
  pdfPath?: string;
  lastError?: string | null;
  lastReason?: string | null;
};

type BlockTypography = {
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  lineHeight: number;
  letterSpacing: string;
  color: string;
  fontFamily: string;
};

type PageBlockMetrics = {
  block: LayoutBlock;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
  availableHeight: number;
};

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8765";
const DEFAULT_TARGET_LANG = "zh-CN";
const DEFAULT_RADIUS = 1;
const DEFAULT_AUTO_PREFETCH = true;
const DEFAULT_FONT_SCALE = 1;
const DEFAULT_LINE_SPACING = 1;

export class DualTranslateReader {
  private toolbarHandler: _ZoteroTypes.Reader.EventHandler<"renderToolbar"> | null =
    null;
  private viewMenuHandler: _ZoteroTypes.Reader.EventHandler<"createViewContextMenu"> | null =
    null;
  private states = new Map<_ZoteroTypes.ReaderInstance<"pdf">, ReaderState>();

  async startup() {
    this.log("startup");
    this.toolbarHandler = (event) => {
      void this.onRenderToolbar(event);
    };
    this.viewMenuHandler = (event) => {
      this.onCreateViewContextMenu(event);
    };
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      this.toolbarHandler,
      config.addonID,
    );
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      this.viewMenuHandler,
      config.addonID,
    );
  }

  shutdown() {
    this.log("shutdown");
    if (this.toolbarHandler) {
      Zotero.Reader.unregisterEventListener(
        "renderToolbar",
        this.toolbarHandler,
      );
      this.toolbarHandler = null;
    }
    if (this.viewMenuHandler) {
      Zotero.Reader.unregisterEventListener(
        "createViewContextMenu",
        this.viewMenuHandler,
      );
      this.viewMenuHandler = null;
    }
    for (const reader of [...this.states.keys()]) {
      this.disableMode(reader);
    }
  }

  private async onRenderToolbar(
    event: _ZoteroTypes.Reader.EventParams<"renderToolbar">,
  ) {
    const reader = event.reader as _ZoteroTypes.ReaderInstance<"pdf">;
    if (!this.isSupportedReader(reader)) {
      return;
    }
    this.logReader(reader, "renderToolbar event");
    await this.waitForPrimaryReader(reader);
    const doc = event.doc || this.getPrimaryReaderDocument(reader);
    if (!doc) {
      this.logReader(reader, "renderToolbar aborted: no primary document");
      return;
    }
    this.ensurePrimaryStyles(doc);
    if (doc.querySelector("[data-zdt-toolbar-button='1']")) {
      this.logReader(reader, "toolbar button already exists");
      this.syncToolbarButtons(reader);
      return;
    }

    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.zdtToolbarButton = "1";
    button.className = "zdt-toolbar-button";
    button.textContent = "Dual Translate";
    button.title = "Toggle translated split view";
    button.addEventListener("click", () => {
      void this.toggleMode(reader);
    });
    event.append(button);
    this.logReader(reader, "toolbar button injected");
    this.syncToolbarButtons(reader);
  }

  private onCreateViewContextMenu(
    event: _ZoteroTypes.Reader.EventParams<"createViewContextMenu">,
  ) {
    const reader = event.reader as _ZoteroTypes.ReaderInstance<"pdf">;
    if (!this.isSupportedReader(reader)) {
      return;
    }
    this.logReader(reader, "createViewContextMenu event");
    event.append({
      label: this.states.has(reader)
        ? "Hide Dual Translate"
        : "Show Dual Translate",
      onCommand: () => {
        void this.toggleMode(reader);
      },
    });
  }

  async ensureSecondaryFonts(doc: Document) {
    if (doc.getElementById("zdt-secondary-fonts")) return;

    const style = doc.createElement("style");
    style.id = "zdt-secondary-fonts";
    style.textContent = `
      @font-face {
        font-family: "PUHUI";
        src: url("file:///Users/pauli/Downloads/AlibabaPuHuiTi-3/AlibabaPuHuiTi-3-55-Regular/AlibabaPuHuiTi-3-55-Regular.otf") format("opentype");
        font-weight: 400;
        font-style: normal;
      }
    `;
    (doc.head || doc.documentElement || doc.body)?.appendChild(style);
  }

  private async toggleMode(reader: _ZoteroTypes.ReaderInstance<"pdf">) {
    this.logReader(
      reader,
      `toggleMode active=${this.states.has(reader) ? "yes" : "no"}`,
    );
    if (this.states.has(reader)) {
      this.disableMode(reader);
      this.syncToolbarButtons(reader);
      return;
    }

    try {
      await this.enableMode(reader);
      this.syncToolbarButtons(reader);
      this.logReader(reader, "toggleMode enabled");
    } catch (error) {
      this.logError("enableMode failed", error);
      throw error;
    }
  }

  private async enableMode(reader: _ZoteroTypes.ReaderInstance<"pdf">) {
    if (!this.isSupportedReader(reader)) {
      return;
    }
    this.logReader(reader, "enableMode start");
    await this.waitForPrimaryReader(reader);

    const primaryDoc = this.getPrimaryReaderDocument(reader);
    const primaryApp = this.getPrimaryPDFViewerApplication(reader);
    if (!primaryDoc || !primaryApp) {
      throw new Error("Primary reader view is not ready.");
    }
    this.ensurePrimaryStyles(primaryDoc);
    this.logReader(
      reader,
      `primary ready page=${this.getCurrentPage(reader)} total=${this.getTotalPages(reader)}`,
    );

    const splitRestore = await this.ensureVerticalSplit(reader);
    this.logReader(
      reader,
      `split ready previousType=${splitRestore.previousType || "none"} changedByPlugin=${splitRestore.changedByPlugin ? "yes" : "no"}`,
    );
    const secondaryView = await this.waitForSecondaryView(reader);
    const secondaryDoc = secondaryView._iframeWindow?.document || null;
    const secondaryApp = secondaryView._iframeWindow?.PDFViewerApplication;
    if (!secondaryDoc || !secondaryApp) {
      throw new Error("Secondary reader view is not ready.");
    }
    // await this.ensureSecondaryFonts(secondaryDoc);
    this.logReader(reader, "secondary view ready");

    this.ensureSecondaryStyles(secondaryDoc);
    secondaryDoc.body?.classList.add("zdt-translation-mode");
    this.logReader(reader, "secondary translation mode applied");

    const chrome = this.buildSecondaryChrome(secondaryDoc);
    secondaryDoc.body?.appendChild(chrome.host);

    const state: ReaderState = {
      reader,
      primaryDoc,
      secondaryDoc,
      primaryApp,
      secondaryApp,
      chrome,
      currentPage: this.getCurrentPage(reader),
      totalPages: this.getTotalPages(reader),
      requestSerial: 0,
      pageCache: new Map(),
      fetchedKeys: new Set(),
      inflightKeys: new Set(),
      cleanupFns: [],
      splitRestore,
      settingsKey: "",
      panelCollapsed: false,
      lastError: null,
      lastReason: null,
    };
    this.logReader(
      reader,
      `state created currentPage=${state.currentPage} totalPages=${state.totalPages}`,
    );

    chrome.refreshButton.addEventListener("click", () => {
      this.invalidateTranslations(state, false);
      void this.ensureCurrentPage(state, true);
    });
    chrome.fetchNearbyButton.addEventListener("click", () => {
      void this.fetchNearby(state, true);
    });
    chrome.fontDownButton.addEventListener("click", () => {
      this.adjustFontScale(state, -0.05);
    });
    chrome.fontUpButton.addEventListener("click", () => {
      this.adjustFontScale(state, 0.05);
    });
    chrome.lineDownButton.addEventListener("click", () => {
      this.adjustLineSpacing(state, -0.05);
    });
    chrome.lineUpButton.addEventListener("click", () => {
      this.adjustLineSpacing(state, 0.05);
    });
    chrome.panelToggleButton.addEventListener("click", () => {
      state.panelCollapsed = !state.panelCollapsed;
      this.logReader(
        state.reader,
        `panelCollapsed=${state.panelCollapsed ? "yes" : "no"}`,
      );
      this.renderChrome(state);
    });

    const pagehideListener = () => {
      this.disableMode(reader);
      this.syncToolbarButtons(reader);
    };
    primaryDoc.defaultView?.addEventListener("pagehide", pagehideListener, {
      once: true,
    });
    state.cleanupFns.push(() => {
      primaryDoc.defaultView?.removeEventListener("pagehide", pagehideListener);
    });

    this.states.set(reader, state);
    this.attachReaderTracking(state);
    const prefs = this.syncSettings(state);
    this.logReader(
      reader,
      `prefs service=${prefs.serviceURL} target=${prefs.targetLang} radius=${prefs.radius} autoPrefetch=${prefs.autoPrefetch}`,
    );
    this.syncSecondaryState(state, true);
    this.renderChrome(state);
    this.renderSecondaryPages(state);
    await this.ensureCurrentPage(state, false);
  }

  private disableMode(reader: _ZoteroTypes.ReaderInstance<"pdf">) {
    const state = this.states.get(reader);
    if (!state) {
      return;
    }
    this.logReader(reader, "disableMode start");
    state.requestSerial += 1;

    for (const cleanup of state.cleanupFns.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        this.logError("cleanup failed", error);
      }
    }

    state.secondaryDoc.body?.classList.remove("zdt-translation-mode");
    if (state.chrome.host.isConnected) {
      state.chrome.host.remove();
    }
    this.clearAllPageOverlays(state.secondaryDoc);

    if (state.splitRestore.changedByPlugin) {
      this.restoreSplitState(reader, state.splitRestore);
    }

    this.states.delete(reader);
    this.logReader(reader, "disableMode finished");
  }

  private attachReaderTracking(state: ReaderState) {
    this.logReader(state.reader, "attachReaderTracking");
    const onPrimaryPageChanging = (event: { pageNumber?: number }) => {
      const page = event?.pageNumber || this.getCurrentPage(state.reader);
      this.logReader(state.reader, `pagechanging event page=${page}`);
      this.onPrimaryPageChanged(state, page);
    };
    state.primaryApp.eventBus?.on?.("pagechanging", onPrimaryPageChanging);
    state.cleanupFns.push(() => {
      state.primaryApp.eventBus?.off?.("pagechanging", onPrimaryPageChanging);
    });

    const onPrimaryScaleChanging = () => {
      this.syncSecondaryState(state, false);
      this.renderSecondaryPages(state);
    };
    state.primaryApp.eventBus?.on?.("scalechanging", onPrimaryScaleChanging);
    state.cleanupFns.push(() => {
      state.primaryApp.eventBus?.off?.("scalechanging", onPrimaryScaleChanging);
    });

    const onPrimaryRotationChanging = () => {
      this.syncSecondaryState(state, false);
      this.renderSecondaryPages(state);
    };
    state.primaryApp.eventBus?.on?.(
      "rotationchanging",
      onPrimaryRotationChanging,
    );
    state.cleanupFns.push(() => {
      state.primaryApp.eventBus?.off?.(
        "rotationchanging",
        onPrimaryRotationChanging,
      );
    });

    const rerenderSecondary = () => {
      this.renderSecondaryPages(state);
    };
    state.secondaryApp.eventBus?.on?.("pagerendered", rerenderSecondary);
    state.secondaryApp.eventBus?.on?.("updateviewarea", rerenderSecondary);
    state.secondaryApp.eventBus?.on?.("scalechanging", rerenderSecondary);
    state.secondaryApp.eventBus?.on?.("rotationchanging", rerenderSecondary);
    state.cleanupFns.push(() => {
      state.secondaryApp.eventBus?.off?.("pagerendered", rerenderSecondary);
      state.secondaryApp.eventBus?.off?.("updateviewarea", rerenderSecondary);
      state.secondaryApp.eventBus?.off?.("scalechanging", rerenderSecondary);
      state.secondaryApp.eventBus?.off?.("rotationchanging", rerenderSecondary);
    });

    const pollTimer = state.primaryDoc.defaultView?.setInterval(() => {
      if (!this.states.has(state.reader)) {
        return;
      }
      const currentPage = this.getCurrentPage(state.reader);
      if (currentPage !== state.currentPage) {
        this.onPrimaryPageChanged(state, currentPage);
        return;
      }
      const totalPages = this.getTotalPages(state.reader);
      if (totalPages !== state.totalPages) {
        state.totalPages = totalPages;
        this.renderChrome(state);
      }
      this.syncSettings(state);
      this.syncSecondaryState(state, false);
      this.renderSecondaryPages(state);
    }, 450);
    if (pollTimer != null) {
      state.cleanupFns.push(() => {
        state.primaryDoc.defaultView?.clearInterval(pollTimer);
      });
    }
  }

  private onPrimaryPageChanged(state: ReaderState, page: number) {
    if (page < 1 || !this.states.has(state.reader)) {
      return;
    }
    if (page === state.currentPage) {
      this.syncSecondaryState(state, false);
      this.renderSecondaryPages(state);
      return;
    }
    this.logReader(
      state.reader,
      `onPrimaryPageChanged ${state.currentPage} -> ${page}`,
    );
    state.currentPage = page;
    state.totalPages = this.getTotalPages(state.reader);
    this.syncSecondaryState(state, true);
    this.renderChrome(state);
    this.renderSecondaryPages(state);
    void this.ensureCurrentPage(state, false);
  }

  private async ensureCurrentPage(state: ReaderState, force: boolean) {
    const prefs = this.syncSettings(state);
    const hasCurrentPage = state.pageCache.has(state.currentPage);
    this.logReader(
      state.reader,
      `ensureCurrentPage page=${state.currentPage} force=${force ? "yes" : "no"} cached=${hasCurrentPage ? "yes" : "no"} autoPrefetch=${prefs.autoPrefetch ? "yes" : "no"}`,
    );

    if (!hasCurrentPage) {
      this.setStatus(state, `Loading page ${state.currentPage}...`);
    } else {
      this.setStatus(state, `Page ${state.currentPage} ready`);
    }
    this.renderChrome(state);
    this.renderSecondaryPages(state);

    if (!hasCurrentPage || force || prefs.autoPrefetch) {
      await this.fetchNearby(state, force);
    }

    if (!this.states.has(state.reader)) {
      return;
    }
    if (state.pageCache.has(state.currentPage)) {
      this.setStatus(state, `Showing page ${state.currentPage}`);
    }
    this.renderChrome(state);
    this.renderSecondaryPages(state);
  }

  private async fetchNearby(state: ReaderState, force: boolean) {
    const prefs = this.syncSettings(state);
    const centerPage = state.currentPage;
    const requestKey = this.makeRequestKey(prefs, centerPage);
    if (!force && state.fetchedKeys.has(requestKey)) {
      this.logReader(
        state.reader,
        `fetchNearby skipped cached request page=${centerPage}`,
      );
      return;
    }
    if (state.inflightKeys.has(requestKey)) {
      this.logReader(
        state.reader,
        `fetchNearby skipped inflight request page=${centerPage}`,
      );
      return;
    }

    const serial = state.requestSerial;
    state.inflightKeys.add(requestKey);
    this.logReader(
      state.reader,
      `fetchNearby start page=${centerPage} radius=${prefs.radius} force=${force ? "yes" : "no"} serial=${serial}`,
    );
    this.setStatus(
      state,
      force
        ? `Fetching translated pages around ${centerPage}...`
        : `Prefetching translated pages around ${centerPage}...`,
    );
    this.renderChrome(state);
    this.renderSecondaryPages(state);

    try {
      const response = await this.requestTranslation(state, centerPage, prefs);
      if (
        !this.states.has(state.reader) ||
        serial !== state.requestSerial ||
        state.settingsKey !== this.makeSettingsKey(prefs)
      ) {
        this.logReader(
          state.reader,
          `fetchNearby dropped stale response page=${centerPage} serial=${serial}`,
        );
        return;
      }

      state.lastError = null;
      state.lastReason = response.reason || null;
      for (const page of response.pages || []) {
        state.pageCache.set(page.page, page);
      }
      state.fetchedKeys.add(requestKey);
      this.logReader(
        state.reader,
        `fetchNearby success requested=${centerPage} receivedPages=${(response.pages || []).map((page) => page.page).join(",") || "none"} status=${response.status}`,
      );
      this.renderChrome(state);
      this.renderSecondaryPages(state);
    } catch (error) {
      if (!this.states.has(state.reader) || serial !== state.requestSerial) {
        this.logReader(
          state.reader,
          `fetchNearby ignored error from stale request page=${centerPage} serial=${serial}`,
        );
        return;
      }
      state.lastError = this.stringifyError(error);
      this.logError("translation request failed", error);
      if (!state.pageCache.has(state.currentPage)) {
        this.setStatus(state, "Translation failed");
      }
      this.renderChrome(state);
      this.renderSecondaryPages(state);
    } finally {
      state.inflightKeys.delete(requestKey);
      this.logReader(
        state.reader,
        `fetchNearby end page=${centerPage} inflight=${state.inflightKeys.size}`,
      );
    }
  }

  private async requestTranslation(
    state: ReaderState,
    page: number,
    prefs: PrefSnapshot,
  ): Promise<TranslateResponse> {
    const payload = {
      pdf_path: await this.getPDFPath(state),
      page,
      radius: prefs.radius,
      target_lang: prefs.targetLang,
    };
    this.logReader(
      state.reader,
      `POST ${prefs.serviceURL}/translate ${JSON.stringify(payload)}`,
    );

    const xhr = await Zotero.HTTP.request(
      "POST",
      `${prefs.serviceURL}/translate`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        responseType: "json",
        successCodes: false,
      },
    );

    const status = Number(xhr?.status || 0);
    const response =
      typeof xhr?.response === "string"
        ? (JSON.parse(xhr.response) as TranslateResponse)
        : (xhr?.response as TranslateResponse);

    if (status < 200 || status >= 300) {
      const detail =
        response?.reason ||
        (response as any)?.detail ||
        xhr?.responseText ||
        `HTTP ${status}`;
      throw new Error(detail);
    }
    if (!response) {
      throw new Error("The translation service returned an empty response.");
    }
    this.logReader(
      state.reader,
      `response status=${status} requested=${response.requested_page} pages=${(response.pages || []).map((pageLayout) => pageLayout.page).join(",") || "none"} reason=${response.reason || ""}`,
    );
    return response;
  }

  private buildSecondaryChrome(doc: Document): ReaderChrome {
    const host = doc.createElement("div");
    host.className = "zdt-floating-ui";

    const header = doc.createElement("div");
    header.className = "zdt-floating-header";

    const title = doc.createElement("strong");
    title.className = "zdt-floating-title";
    title.textContent = "Dual Translate";

    const pageBadge = doc.createElement("span");
    pageBadge.className = "zdt-page-badge";

    const panelToggleButton = doc.createElement("button");
    panelToggleButton.type = "button";
    panelToggleButton.className = "zdt-chip-button zdt-panel-toggle";
    panelToggleButton.textContent = "Hide";

    header.append(title, pageBadge, panelToggleButton);

    const body = doc.createElement("div");
    body.className = "zdt-floating-body";

    const settings = doc.createElement("div");
    settings.className = "zdt-floating-settings";

    const fontControls = doc.createElement("div");
    fontControls.className = "zdt-font-controls";

    const fontLabel = doc.createElement("span");
    fontLabel.className = "zdt-font-label";
    fontLabel.textContent = "Font";

    const fontDownButton = doc.createElement("button");
    fontDownButton.type = "button";
    fontDownButton.className = "zdt-chip-button";
    fontDownButton.textContent = "A-";

    const fontValue = doc.createElement("span");
    fontValue.className = "zdt-font-value";

    const fontUpButton = doc.createElement("button");
    fontUpButton.type = "button";
    fontUpButton.className = "zdt-chip-button";
    fontUpButton.textContent = "A+";

    fontControls.append(fontLabel, fontDownButton, fontValue, fontUpButton);

    const lineControls = doc.createElement("div");
    lineControls.className = "zdt-line-controls";

    const lineLabel = doc.createElement("span");
    lineLabel.className = "zdt-line-label";
    lineLabel.textContent = "Line";

    const lineDownButton = doc.createElement("button");
    lineDownButton.type = "button";
    lineDownButton.className = "zdt-chip-button";
    lineDownButton.textContent = "L-";

    const lineValue = doc.createElement("span");
    lineValue.className = "zdt-line-value";

    const lineUpButton = doc.createElement("button");
    lineUpButton.type = "button";
    lineUpButton.className = "zdt-chip-button";
    lineUpButton.textContent = "L+";

    lineControls.append(lineLabel, lineDownButton, lineValue, lineUpButton);

    const actions = doc.createElement("div");
    actions.className = "zdt-floating-actions";

    const refreshButton = doc.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "zdt-chip-button";
    refreshButton.textContent = "Refresh";

    const fetchNearbyButton = doc.createElement("button");
    fetchNearbyButton.type = "button";
    fetchNearbyButton.className = "zdt-chip-button zdt-chip-button-primary";
    fetchNearbyButton.textContent = "Fetch Nearby";

    actions.append(refreshButton, fetchNearbyButton);

    const status = doc.createElement("div");
    status.className = "zdt-status";
    status.textContent = "Waiting for page sync";

    const nearbyRail = doc.createElement("div");
    nearbyRail.className = "zdt-nearby-rail";

    settings.append(fontControls, lineControls);
    body.append(settings, actions, status, nearbyRail);
    host.append(header, body);

    return {
      host,
      body,
      status,
      pageBadge,
      nearbyRail,
      refreshButton,
      fetchNearbyButton,
      fontDownButton,
      fontUpButton,
      fontValue,
      lineDownButton,
      lineUpButton,
      lineValue,
      panelToggleButton,
    };
  }

  private renderChrome(state: ReaderState) {
    const prefs = this.readPrefs();
    state.chrome.host.classList.toggle("is-collapsed", state.panelCollapsed);
    state.chrome.pageBadge.textContent = `Page ${state.currentPage}`;
    state.chrome.fontValue.textContent = `${Math.round(prefs.fontScale * 100)}%`;
    state.chrome.lineValue.textContent = `${Math.round(prefs.lineSpacing * 100)}%`;
    state.chrome.panelToggleButton.textContent = state.panelCollapsed
      ? "Show"
      : "Hide";
    this.renderNearbyRail(state, prefs.radius);
  }

  private renderNearbyRail(state: ReaderState, radius: number) {
    const doc = state.secondaryDoc;
    state.chrome.nearbyRail.replaceChildren();

    const chipRadius = Math.max(2, radius);
    const start = Math.max(1, state.currentPage - chipRadius);
    const end = state.totalPages
      ? Math.min(state.totalPages, state.currentPage + chipRadius)
      : state.currentPage + chipRadius;

    for (let page = start; page <= end; page += 1) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "zdt-page-chip";
      if (page === state.currentPage) {
        button.classList.add("is-current");
      }
      if (state.pageCache.has(page)) {
        button.classList.add("is-cached");
      }
      button.textContent = String(page);
      button.title = state.pageCache.has(page)
        ? `Page ${page} is cached. Jump to it.`
        : `Jump to page ${page} and fetch translation.`;
      button.addEventListener("click", () => {
        void state.reader.navigate({ pageIndex: page - 1 });
        if (!state.pageCache.has(page)) {
          state.currentPage = page;
          this.syncSecondaryState(state, true);
          this.renderChrome(state);
          this.renderSecondaryPages(state);
          void this.fetchNearby(state, true);
        }
      });
      state.chrome.nearbyRail.appendChild(button);
    }
  }

  private renderSecondaryPages(state: ReaderState) {
    const pages = Array.from(
      state.secondaryDoc.querySelectorAll(".page[data-page-number]"),
    ) as HTMLElement[];
    if (!pages.length) {
      return;
    }

    const activePages = new Set<number>();
    for (const pageElement of pages) {
      const pageNumber = Number.parseInt(
        pageElement.dataset.pageNumber || "",
        10,
      );
      if (!Number.isFinite(pageNumber) || pageNumber < 1) {
        continue;
      }
      activePages.add(pageNumber);
      const layout = state.pageCache.get(pageNumber);
      if (layout) {
        this.renderTranslatedPage(state, pageElement, layout);
        continue;
      }
      if (pageNumber === state.currentPage) {
        this.renderPagePlaceholder(
          state,
          pageElement,
          this.getCurrentPagePlaceholder(state),
          state.lastError ? "error" : state.lastReason ? "warning" : "empty",
        );
      } else {
        this.removePageOverlay(pageElement);
      }
    }

    for (const overlay of state.secondaryDoc.querySelectorAll<HTMLElement>(
      ".zdt-page-overlay",
    )) {
      const pageNumber = Number.parseInt(overlay.dataset.pageNumber || "", 10);
      if (!activePages.has(pageNumber)) {
        overlay.remove();
      }
    }
  }

  private renderTranslatedPage(
    state: ReaderState,
    pageElement: HTMLElement,
    layout: PageLayout,
  ) {
    const overlay = this.ensurePageOverlay(pageElement, layout.page);
    overlay.className = "zdt-page-overlay";
    overlay.replaceChildren();
    this.applyPageColors(state, pageElement, overlay);

    const inner = state.secondaryDoc.createElement("div");
    inner.className = "zdt-page-overlay-inner";
    inner.style.width = `${Math.max(1, layout.width)}px`;
    inner.style.height = `${Math.max(1, layout.height)}px`;
    const visualLayer = state.secondaryDoc.createElement("div");
    visualLayer.className = "zdt-visual-layer";
    const textLayer = state.secondaryDoc.createElement("div");
    textLayer.className = "zdt-text-layer";

    const prefs = this.readPrefs();
    const scale = this.measurePageScale(pageElement, layout);
    inner.style.transform = `scale(${scale})`;
    inner.append(visualLayer, textLayer);
    overlay.appendChild(inner);

    for (const metrics of this.buildPageBlockMetrics(layout)) {
      const { block } = metrics;
      const blockText = block.translated_text || block.text || "";
      if (this.shouldRenderPassthroughVisual(block)) {
        const visual = this.createPassthroughVisual(
          state.secondaryDoc,
          pageElement,
          layout,
          metrics,
        );
        if (visual) {
          visualLayer.appendChild(visual);
        }
        continue;
      }
      if (block.render_mode === "passthrough" || !blockText.trim()) {
        continue;
      }
      const typography = this.getBlockTypography(
        block,
        prefs.fontScale,
        prefs.lineSpacing,
      );
      const node = state.secondaryDoc.createElement("div");
      node.className = "zdt-text-block";
      node.dataset.blockType = block.type || "paragraph";
      if (block.docling_label) {
        node.dataset.doclingLabel = block.docling_label;
      }
      if (block.content_kind) {
        node.dataset.contentKind = block.content_kind;
      }
      node.textContent = blockText;
      node.style.left = `${Math.max(0, metrics.x0)}px`;
      node.style.top = `${Math.max(0, metrics.y0)}px`;
      node.style.width = `${Math.max(48, metrics.width)}px`;
      node.style.fontSize = `${typography.fontSize}px`;
      node.style.fontWeight = String(typography.fontWeight);
      node.style.fontStyle = typography.fontStyle;
      node.style.lineHeight = String(typography.lineHeight);
      node.style.letterSpacing = typography.letterSpacing;
      node.style.color = typography.color;
      node.style.fontFamily = typography.fontFamily;
      textLayer.appendChild(node);
      this.fitTextBlock(node, metrics, typography);
    }
  }

  private renderPagePlaceholder(
    state: ReaderState,
    pageElement: HTMLElement,
    message: string,
    tone: "empty" | "warning" | "error",
  ) {
    const pageNumber = Number.parseInt(
      pageElement.dataset.pageNumber || "",
      10,
    );
    const overlay = this.ensurePageOverlay(pageElement, pageNumber);
    overlay.className = `zdt-page-overlay is-placeholder is-${tone}`;
    overlay.replaceChildren();
    this.applyPageColors(state, pageElement, overlay);

    const card = state.secondaryDoc.createElement("div");
    card.className = `zdt-placeholder-card is-${tone}`;
    card.textContent = message;
    overlay.appendChild(card);
  }

  private ensurePageOverlay(pageElement: HTMLElement, pageNumber: number) {
    let overlay = pageElement.querySelector<HTMLElement>(
      ":scope > .zdt-page-overlay",
    );
    if (!overlay) {
      const ownerDocument =
        pageElement.ownerDocument || this.getDocumentFromNode(pageElement);
      overlay = ownerDocument.createElement("div");
      overlay.className = "zdt-page-overlay";
      pageElement.appendChild(overlay);
    }
    overlay.dataset.pageNumber = String(pageNumber);
    return overlay;
  }

  private removePageOverlay(pageElement: HTMLElement) {
    pageElement.querySelector(":scope > .zdt-page-overlay")?.remove();
  }

  private clearAllPageOverlays(doc: Document) {
    for (const overlay of doc.querySelectorAll(".zdt-page-overlay")) {
      overlay.remove();
    }
  }

  private applyPageColors(
    state: ReaderState,
    pageElement: HTMLElement,
    overlay: HTMLElement,
  ) {
    const view = state.secondaryDoc.defaultView;
    const pageStyles = view?.getComputedStyle(pageElement);
    const bodyStyles = state.secondaryDoc.body
      ? view?.getComputedStyle(state.secondaryDoc.body)
      : null;
    const pageBackground =
      pageStyles?.backgroundColor &&
      pageStyles.backgroundColor !== "rgba(0, 0, 0, 0)"
        ? pageStyles.backgroundColor
        : bodyStyles?.backgroundColor || "#ffffff";
    const pageColor = bodyStyles?.color || pageStyles?.color || "#0f172a";
    overlay.style.setProperty("--zdt-paper", pageBackground);
    overlay.style.setProperty("--zdt-ink", pageColor);
  }

  private measurePageScale(pageElement: HTMLElement, layout: PageLayout) {
    const width = Math.max(1, pageElement.clientWidth);
    const height = Math.max(1, pageElement.clientHeight);
    const widthScale = width / Math.max(1, layout.width);
    const heightScale = height / Math.max(1, layout.height);
    return Math.max(0.1, Math.min(widthScale, heightScale));
  }

  private getCurrentPagePlaceholder(state: ReaderState) {
    if (state.lastError && !state.pageCache.has(state.currentPage)) {
      return state.lastError;
    }
    if (state.lastReason && !state.pageCache.has(state.currentPage)) {
      return state.lastReason;
    }
    return `Loading translated page ${state.currentPage}...`;
  }

  private buildPageBlockMetrics(layout: PageLayout): PageBlockMetrics[] {
    const metrics = (layout.blocks || []).map((block) => {
      const [x0, y0, x1, y1] = block.bbox || [0, 0, 0, 0];
      const left = Math.max(0, this.toFiniteNumber(x0));
      const top = Math.max(0, this.toFiniteNumber(y0));
      const right = Math.max(left + 1, this.toFiniteNumber(x1, left + 1));
      const bottom = Math.max(top + 1, this.toFiniteNumber(y1, top + 1));
      return {
        block,
        x0: left,
        y0: top,
        x1: right,
        y1: bottom,
        width: Math.max(8, right - left),
        height: Math.max(8, bottom - top),
        availableHeight: Math.max(8, bottom - top),
      };
    });

    return metrics.map((metric, index) => ({
      ...metric,
      availableHeight: this.getAvailableBlockHeight(
        metrics,
        index,
        Math.max(1, layout.height),
      ),
    }));
  }

  private getAvailableBlockHeight(
    metrics: PageBlockMetrics[],
    currentIndex: number,
    pageHeight: number,
  ) {
    const current = metrics[currentIndex];
    let bottomLimit = pageHeight;

    for (let index = 0; index < metrics.length; index += 1) {
      if (index === currentIndex) {
        continue;
      }
      const candidate = metrics[index];
      if (candidate.y0 <= current.y0 + 1) {
        continue;
      }
      if (!this.blocksShareColumn(current, candidate)) {
        continue;
      }
      bottomLimit = Math.min(bottomLimit, candidate.y0);
    }

    return Math.max(8, bottomLimit - current.y0 - 2);
  }

  private blocksShareColumn(
    current: Pick<PageBlockMetrics, "x0" | "x1">,
    candidate: Pick<PageBlockMetrics, "x0" | "x1">,
  ) {
    const overlapWidth =
      Math.min(current.x1, candidate.x1) - Math.max(current.x0, candidate.x0);
    const minWidth = Math.max(
      1,
      Math.min(current.x1 - current.x0, candidate.x1 - candidate.x0),
    );
    if (overlapWidth >= Math.min(24, minWidth * 0.2)) {
      return true;
    }

    const currentCenter = (current.x0 + current.x1) / 2;
    const candidateCenter = (candidate.x0 + candidate.x1) / 2;
    return (
      (currentCenter >= candidate.x0 - 16 &&
        currentCenter <= candidate.x1 + 16) ||
      (candidateCenter >= current.x0 - 16 &&
        candidateCenter <= current.x1 + 16)
    );
  }

  private fitTextBlock(
    node: HTMLElement,
    metrics: PageBlockMetrics,
    typography: BlockTypography,
  ) {
    const maxHeight = Math.max(8, metrics.availableHeight);
    const baseFontSize = typography.fontSize;
    const minFontSize = Number(
      Math.max(4.5, baseFontSize * 0.55).toFixed(2),
    );

    node.style.maxHeight = `${maxHeight}px`;
    node.style.overflow = "hidden";

    if (!this.textBlockFits(node, maxHeight)) {
      const setFontSize = (size: number) => {
        node.style.fontSize = `${Number(size.toFixed(2))}px`;
      };

      setFontSize(minFontSize);
      if (this.textBlockFits(node, maxHeight)) {
        let low = minFontSize;
        let high = baseFontSize;
        let best = minFontSize;
        for (let step = 0; step < 8; step += 1) {
          const mid = (low + high) / 2;
          setFontSize(mid);
          if (this.textBlockFits(node, maxHeight)) {
            best = mid;
            low = mid;
          } else {
            high = mid;
          }
        }
        setFontSize(best);
      }
    }

    const renderedHeight = Math.min(maxHeight, Math.max(1, node.scrollHeight));
    node.style.minHeight = `${Math.max(metrics.height, renderedHeight)}px`;
  }

  private shouldRenderPassthroughVisual(block: LayoutBlock) {
    return (
      block.render_mode === "passthrough" &&
      (block.content_kind === "picture" || block.content_kind === "table")
    );
  }

  private createPassthroughVisual(
    doc: Document,
    pageElement: HTMLElement,
    layout: PageLayout,
    metrics: PageBlockMetrics,
  ) {
    const sourceCanvas = this.getPageCanvas(pageElement);
    if (!sourceCanvas || sourceCanvas.width < 1 || sourceCanvas.height < 1) {
      return null;
    }

    const scaleX = sourceCanvas.width / Math.max(1, layout.width);
    const scaleY = sourceCanvas.height / Math.max(1, layout.height);
    const sx = Math.max(0, Math.floor(metrics.x0 * scaleX));
    const sy = Math.max(0, Math.floor(metrics.y0 * scaleY));
    const sw = Math.min(
      sourceCanvas.width - sx,
      Math.max(1, Math.ceil(metrics.width * scaleX)),
    );
    const sh = Math.min(
      sourceCanvas.height - sy,
      Math.max(1, Math.ceil(metrics.height * scaleY)),
    );
    if (sw < 1 || sh < 1) {
      return null;
    }

    const canvas = doc.createElement("canvas") as HTMLCanvasElement;
    canvas.className = "zdt-passthrough-block";
    canvas.style.left = `${Math.max(0, metrics.x0)}px`;
    canvas.style.top = `${Math.max(0, metrics.y0)}px`;
    canvas.style.width = `${Math.max(1, metrics.width)}px`;
    canvas.style.height = `${Math.max(1, metrics.height)}px`;
    canvas.width = sw;
    canvas.height = sh;

    const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!context) {
      return null;
    }
    context.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
  }

  private getPageCanvas(pageElement: HTMLElement) {
    return pageElement.querySelector("canvas") as HTMLCanvasElement | null;
  }

  private textBlockFits(node: HTMLElement, maxHeight: number) {
    return (
      node.scrollHeight <= maxHeight + 1 &&
      node.scrollWidth <= node.clientWidth + 1
    );
  }

  private ensurePrimaryStyles(doc: Document) {
    if (doc.getElementById("zdt-primary-styles")) {
      return;
    }
    const style = doc.createElement("style");
    style.id = "zdt-primary-styles";
    style.textContent = `
      .zdt-toolbar-button {
        margin-inline-start: 8px;
        padding: 4px 10px;
        border: 1px solid rgba(15, 23, 42, 0.14);
        border-radius: 999px;
        background: linear-gradient(135deg, #0d9488, #0f766e);
        color: #fff;
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
      }
      .zdt-toolbar-button.is-active {
        background: linear-gradient(135deg, #0f172a, #1f2937);
      }
    `;
    (doc.head || doc.documentElement || doc.body)?.appendChild(style);
  }

  private ensureSecondaryStyles(doc: Document) {
    if (doc.getElementById("zdt-secondary-styles")) {
      return;
    }

    const style = doc.createElement("style");
    style.id = "zdt-secondary-styles";
    style.textContent = `
      body.zdt-translation-mode .textLayer,
      body.zdt-translation-mode .annotationLayer,
      body.zdt-translation-mode .annotationEditorLayer,
      body.zdt-translation-mode .xfaLayer,
      body.zdt-translation-mode .highlightLayer {
        opacity: 0 !important;
        pointer-events: none !important;
      }
      body.zdt-translation-mode .page {
        position: relative !important;
      }
      .zdt-floating-ui {
        position: fixed;
        top: 14px;
        right: 14px;
        z-index: 2147483647;
        width: min(360px, calc(100vw - 28px));
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        border-radius: 16px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        background: rgba(248, 250, 252, 0.92);
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.16);
        backdrop-filter: blur(16px);
        color: #0f172a;
        font: 12px/1.35 "SF Pro Text", "Segoe UI", sans-serif;
      }
      .zdt-floating-ui.is-collapsed {
        width: auto;
        min-width: 0;
        gap: 0;
        padding: 10px 12px;
      }
      .zdt-floating-header {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 10px;
      }
      .zdt-floating-title {
        font-size: 13px;
        flex: 1 1 auto;
      }
      .zdt-floating-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .zdt-floating-ui.is-collapsed .zdt-floating-body {
        display: none;
      }
      .zdt-floating-settings {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 10px;
        flex-wrap: wrap;
      }
      .zdt-font-controls,
      .zdt-line-controls {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .zdt-font-label,
      .zdt-line-label {
        color: #475569;
        font-weight: 600;
      }
      .zdt-font-value,
      .zdt-line-value {
        min-width: 42px;
        text-align: center;
        font-weight: 700;
        color: #0f172a;
      }
      .zdt-page-badge {
        padding: 4px 10px;
        border-radius: 999px;
        background: #d1fae5;
        color: #065f46;
        font-size: 11px;
        font-weight: 700;
      }
      .zdt-floating-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .zdt-chip-button {
        padding: 7px 10px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.9);
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
      }
      .zdt-panel-toggle {
        margin-left: auto;
      }
      .zdt-chip-button-primary {
        border-color: transparent;
        background: linear-gradient(135deg, #0d9488, #0f766e);
        color: #fff;
      }
      .zdt-status {
        color: #475569;
        white-space: pre-wrap;
      }
      .zdt-nearby-rail {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .zdt-page-chip {
        min-width: 34px;
        padding: 5px 10px;
        border: 1px solid rgba(15, 23, 42, 0.1);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.92);
        color: #334155;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
      }
      .zdt-page-chip.is-current {
        background: #0f766e;
        border-color: transparent;
        color: #fff;
      }
      .zdt-page-chip.is-cached:not(.is-current) {
        background: #ecfeff;
        border-color: rgba(8, 145, 178, 0.2);
        color: #155e75;
      }
      .zdt-page-overlay {
        position: absolute;
        inset: 0;
        z-index: 12;
        overflow: hidden;
        pointer-events: none;
        background: var(--zdt-paper, #ffffff);
        color: var(--zdt-ink, #0f172a);
      }
      .zdt-page-overlay-inner {
        position: relative;
        transform-origin: top left;
      }
      .zdt-visual-layer,
      .zdt-text-layer {
        position: absolute;
        inset: 0;
      }
      .zdt-passthrough-block {
        position: absolute;
        display: block;
        pointer-events: none;
      }
      .zdt-text-block {
        position: absolute;
        box-sizing: border-box;
        padding: 0;
        border-radius: 0;
        background: transparent;
        color: var(--zdt-ink, #0f172a);
        white-space: pre-wrap;
        word-break: break-word;
        overflow: visible;
        text-rendering: optimizeLegibility;
      }
      .zdt-text-block[data-block-type="title"] {
        font-weight: 700;
      }
      .zdt-text-block[data-block-type="caption"] {
        font-style: italic;
      }
      .zdt-page-overlay.is-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .zdt-placeholder-card {
        max-width: min(480px, 100%);
        padding: 16px 18px;
        border-radius: 16px;
        background: rgba(248, 250, 252, 0.96);
        border: 1px solid rgba(15, 23, 42, 0.08);
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.16);
        color: #334155;
        white-space: pre-wrap;
        text-align: center;
      }
      .zdt-placeholder-card.is-warning {
        background: rgba(255, 251, 235, 0.96);
        border-color: rgba(245, 158, 11, 0.35);
        color: #92400e;
      }
      .zdt-placeholder-card.is-error {
        background: rgba(254, 242, 242, 0.96);
        border-color: rgba(239, 68, 68, 0.3);
        color: #991b1b;
      }
      @media (max-width: 720px) {
        .zdt-floating-ui {
          width: calc(100vw - 20px);
          top: 10px;
          right: 10px;
          left: 10px;
        }
      }
    `;
    (doc.head || doc.documentElement || doc.body)?.appendChild(style);
  }

  private syncToolbarButtons(reader: _ZoteroTypes.ReaderInstance<"pdf">) {
    const doc = this.getPrimaryReaderDocument(reader);
    if (!doc) {
      return;
    }
    const active = this.states.has(reader);
    for (const button of doc.querySelectorAll(
      "[data-zdt-toolbar-button='1']",
    )) {
      button.classList.toggle("is-active", active);
    }
  }

  private syncSettings(state: ReaderState) {
    const prefs = this.readPrefs();
    const nextSettingsKey = this.makeSettingsKey(prefs);
    if (state.settingsKey && state.settingsKey !== nextSettingsKey) {
      this.logReader(
        state.reader,
        `settings changed old=${state.settingsKey} new=${nextSettingsKey}`,
      );
      this.invalidateTranslations(state, true);
    }
    state.settingsKey = nextSettingsKey;
    return prefs;
  }

  private invalidateTranslations(state: ReaderState, clearPdfPath: boolean) {
    this.logReader(
      state.reader,
      `invalidateTranslations clearPdfPath=${clearPdfPath ? "yes" : "no"}`,
    );
    state.requestSerial += 1;
    state.pageCache.clear();
    state.fetchedKeys.clear();
    state.inflightKeys.clear();
    state.lastError = null;
    state.lastReason = null;
    if (clearPdfPath) {
      state.pdfPath = undefined;
    }
    this.clearAllPageOverlays(state.secondaryDoc);
    this.renderChrome(state);
    this.renderSecondaryPages(state);
  }

  private readPrefs(): PrefSnapshot {
    const serviceURL = this.normalizeServiceURL(
      String(getPref("serviceURL") || DEFAULT_SERVICE_URL),
    );
    const targetLang =
      String(getPref("targetLang") || DEFAULT_TARGET_LANG).trim() ||
      DEFAULT_TARGET_LANG;
    return {
      serviceURL,
      targetLang,
      radius: this.parseRadius(getPref("radius")),
      autoPrefetch:
        (getPref("autoPrefetch") as boolean | undefined) ??
        DEFAULT_AUTO_PREFETCH,
      fontScale: this.normalizeFontScale(getPref("fontScale")),
      lineSpacing: this.normalizeLineSpacing(getPref("lineSpacing")),
    };
  }

  private makeSettingsKey(prefs: PrefSnapshot) {
    return JSON.stringify({
      service: prefs.serviceURL,
      target: prefs.targetLang,
    });
  }

  private makeRequestKey(prefs: PrefSnapshot, centerPage: number) {
    return JSON.stringify({
      page: centerPage,
      radius: prefs.radius,
      target: prefs.targetLang,
      service: prefs.serviceURL,
    });
  }

  private async ensureVerticalSplit(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): Promise<SplitRestoreState> {
    const internalReader = this.getInternalReader(reader);
    if (!internalReader) {
      throw new Error("Reader internals are not available.");
    }

    const previousType = internalReader.splitType || null;
    const previousSize =
      (internalReader._state?.splitSize as string | undefined) || null;
    this.logReader(
      reader,
      `ensureVerticalSplit previousType=${previousType || "none"} previousSize=${previousSize || "none"}`,
    );

    if (previousType === "vertical") {
      return {
        previousType,
        previousSize,
        changedByPlugin: false,
      };
    }

    if (previousType) {
      this.logReader(reader, "disabling existing split before vertical split");
      internalReader.disableSplitView();
    }
    this.logReader(reader, "enabling vertical split");
    internalReader.toggleVerticalSplit(true);
    internalReader.setSplitViewSize("50%");

    return {
      previousType,
      previousSize,
      changedByPlugin: true,
    };
  }

  private restoreSplitState(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    splitRestore: SplitRestoreState,
  ) {
    const internalReader = this.getInternalReader(reader);
    if (!internalReader) {
      return;
    }

    internalReader.disableSplitView();
    this.logReader(
      reader,
      `restoreSplitState type=${splitRestore.previousType || "none"} size=${splitRestore.previousSize || "none"}`,
    );
    if (splitRestore.previousType === "horizontal") {
      internalReader.toggleHorizontalSplit(true);
    } else if (splitRestore.previousType === "vertical") {
      internalReader.toggleVerticalSplit(true);
    } else {
      return;
    }

    if (splitRestore.previousSize) {
      internalReader.setSplitViewSize(splitRestore.previousSize);
    }
  }

  private syncSecondaryState(state: ReaderState, alignPage: boolean) {
    const primaryViewer = state.primaryApp.pdfViewer;
    const secondaryViewer = state.secondaryApp.pdfViewer;
    if (!primaryViewer || !secondaryViewer) {
      return;
    }

    try {
      if (
        secondaryViewer.currentScaleValue !== primaryViewer.currentScaleValue
      ) {
        secondaryViewer.currentScaleValue = primaryViewer.currentScaleValue;
      }
    } catch (error) {
      this.logError("failed to sync scale", error);
    }

    try {
      if (secondaryViewer.scrollMode !== primaryViewer.scrollMode) {
        secondaryViewer.scrollMode = primaryViewer.scrollMode;
      }
    } catch (error) {
      this.logError("failed to sync scroll mode", error);
    }

    try {
      if (secondaryViewer.spreadMode !== primaryViewer.spreadMode) {
        secondaryViewer.spreadMode = primaryViewer.spreadMode;
      }
    } catch (error) {
      this.logError("failed to sync spread mode", error);
    }

    try {
      if (secondaryViewer.pagesRotation !== primaryViewer.pagesRotation) {
        secondaryViewer.pagesRotation = primaryViewer.pagesRotation;
      }
    } catch (error) {
      this.logError("failed to sync rotation", error);
    }

    if (alignPage) {
      try {
        if (state.secondaryApp.page !== state.currentPage) {
          this.logReader(
            state.reader,
            `syncSecondaryState page ${state.secondaryApp.page} -> ${state.currentPage}`,
          );
          state.secondaryApp.page = state.currentPage;
        }
      } catch (error) {
        this.logError("failed to sync page", error);
      }
    }
  }

  private async getPDFPath(state: ReaderState) {
    if (state.pdfPath) {
      this.logReader(state.reader, `getPDFPath cached path=${state.pdfPath}`);
      return state.pdfPath;
    }
    const reader = state.reader as _ZoteroTypes.ReaderInstance<"pdf"> & {
      _itemID?: number;
      item?: Zotero.Item;
    };
    const itemID =
      reader.itemID || reader._item?.id || reader._itemID || reader.item?.id;
    if (!itemID) {
      throw new Error("Could not resolve the active attachment item.");
    }
    this.logReader(state.reader, `getPDFPath itemID=${itemID}`);
    const item = await Zotero.Items.getAsync(itemID);
    if (!item?.isAttachment?.()) {
      throw new Error("The active item is not a PDF attachment.");
    }
    const pdfPath = await item.getFilePathAsync();
    if (!pdfPath) {
      throw new Error(
        "Could not resolve a local PDF path. Make sure the attachment is stored locally.",
      );
    }
    state.pdfPath = pdfPath;
    this.logReader(state.reader, `getPDFPath resolved path=${pdfPath}`);
    return pdfPath;
  }

  private getInternalReader(reader: _ZoteroTypes.ReaderInstance<"pdf">) {
    return reader._internalReader as
      | _ZoteroTypes.Reader.InternalReader<"pdf">
      | undefined;
  }

  private getPrimaryView(reader: _ZoteroTypes.ReaderInstance<"pdf">) {
    return this.getInternalReader(reader)?._primaryView || null;
  }

  private getPrimaryReaderDocument(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): Document | null {
    return (
      reader._iframeWindow?.document ||
      this.getPrimaryView(reader)?._iframeWindow?.document ||
      null
    );
  }

  private getPrimaryPDFViewerApplication(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ) {
    return (
      reader._iframeWindow?.PDFViewerApplication ||
      this.getPrimaryView(reader)?._iframeWindow?.PDFViewerApplication ||
      null
    );
  }

  private async waitForPrimaryReader(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ) {
    this.logReader(reader, "waitForPrimaryReader start");
    await reader._waitForReader?.();
    const primaryView = this.getPrimaryView(reader);
    if (primaryView?.initializedPromise) {
      await primaryView.initializedPromise;
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const primaryDoc = this.getPrimaryReaderDocument(reader);
      const primaryApp = this.getPrimaryPDFViewerApplication(reader);
      if (primaryDoc && primaryApp) {
        await primaryApp.initializedPromise;
        this.logReader(
          reader,
          `waitForPrimaryReader done attempt=${attempt + 1}`,
        );
        return;
      }
      if (attempt === 0 || attempt === 9 || attempt === 24 || attempt === 49) {
        this.logReader(
          reader,
          `waitForPrimaryReader pending attempt=${attempt + 1} doc=${primaryDoc ? "yes" : "no"} app=${primaryApp ? "yes" : "no"}`,
        );
      }
      await this.sleep(100);
    }
    this.logReader(reader, "waitForPrimaryReader timed out");
    this.logReader(reader, "waitForPrimaryReader done");
  }

  private async waitForSecondaryView(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ) {
    const internalReader = this.getInternalReader(reader);
    if (!internalReader) {
      throw new Error("Reader internals are not available.");
    }

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const secondaryView = internalReader._secondaryView;
      const secondaryApp = secondaryView?._iframeWindow?.PDFViewerApplication;
      if (secondaryView && secondaryApp) {
        await secondaryView.initializedPromise;
        await secondaryApp.initializedPromise;
        this.logReader(
          reader,
          `waitForSecondaryView done attempt=${attempt + 1}`,
        );
        return secondaryView;
      }
      if (attempt === 0 || attempt === 9 || attempt === 24 || attempt === 49) {
        this.logReader(
          reader,
          `waitForSecondaryView pending attempt=${attempt + 1}`,
        );
      }
      await this.sleep(100);
    }

    throw new Error("Timed out waiting for the secondary reader view.");
  }

  private getCurrentPage(reader: _ZoteroTypes.ReaderInstance<"pdf">) {
    if (typeof reader.state?.pageIndex === "number") {
      return reader.state.pageIndex + 1;
    }
    const primaryViewState = this.getInternalReader(reader)?._state
      ?.primaryViewState as { pageIndex?: number } | undefined;
    if (typeof primaryViewState?.pageIndex === "number") {
      return primaryViewState.pageIndex + 1;
    }
    const primaryApp = this.getPrimaryPDFViewerApplication(reader);
    if (typeof primaryApp?.page === "number") {
      return primaryApp.page;
    }
    if (typeof primaryApp?.pdfViewer?.currentPageNumber === "number") {
      return primaryApp.pdfViewer.currentPageNumber;
    }
    return 1;
  }

  private getTotalPages(reader: _ZoteroTypes.ReaderInstance<"pdf">) {
    return Number(this.getPrimaryPDFViewerApplication(reader)?.pagesCount || 0);
  }

  private isSupportedReader(
    reader: _ZoteroTypes.ReaderInstance,
  ): reader is _ZoteroTypes.ReaderInstance<"pdf"> {
    return reader?.type === "pdf";
  }

  private normalizeServiceURL(value: string) {
    const trimmed = value.trim() || DEFAULT_SERVICE_URL;
    return trimmed.replace(/\/+$/, "");
  }

  private parseRadius(value: unknown) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_RADIUS;
    }
    return Math.max(0, Math.min(5, parsed));
  }

  private normalizeFontScale(value: unknown) {
    const parsed = Number.parseFloat(String(value));
    if (!Number.isFinite(parsed)) {
      return DEFAULT_FONT_SCALE;
    }
    return Math.max(0.5, Math.min(1.5, Number(parsed.toFixed(2))));
  }

  private normalizeLineSpacing(value: unknown) {
    const parsed = Number.parseFloat(String(value));
    if (!Number.isFinite(parsed)) {
      return DEFAULT_LINE_SPACING;
    }
    return Math.max(0.8, Math.min(1.6, Number(parsed.toFixed(2))));
  }

  private setStatus(state: ReaderState, text: string) {
    state.chrome.status.textContent = text;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private getBlockTypography(
    block: LayoutBlock,
    fontScale: number,
    lineSpacing: number,
  ): BlockTypography {
    const layer = block.content_layer || "body";
    const type = block.type || "paragraph";
    const fadedColor =
      layer === "furniture"
        ? "rgba(71, 85, 105, 0.8)"
        : "var(--zdt-ink, #0f172a)";
    const titleFont =
      '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
    const bodyFont =
      '"sans-serif", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
    const monoFont =
      '"SFMono-Regular", "SF Mono", "Menlo", "Consolas", monospace';

    const presets: Record<
      string,
      {
        fontSize: number;
        fontWeight: number;
        fontStyle: "normal" | "italic";
        lineHeight: number;
        letterSpacing: string;
        color: string;
        fontFamily: string;
      }
    > = {
      title: {
        fontSize: 18,
        fontWeight: 700,
        fontStyle: "normal",
        lineHeight: 1.28,
        letterSpacing: "-0.01em",
        color: "var(--zdt-ink, #0f172a)",
        fontFamily: titleFont,
      },
      paragraph: {
        fontSize: 12.5,
        fontWeight: 430,
        fontStyle: "normal",
        lineHeight: 1.48,
        letterSpacing: "0",
        color: fadedColor,
        fontFamily: bodyFont,
      },
      text: {
        fontSize: 12.5,
        fontWeight: 430,
        fontStyle: "normal",
        lineHeight: 1.48,
        letterSpacing: "0",
        color: fadedColor,
        fontFamily: bodyFont,
      },
      list: {
        fontSize: 12.5,
        fontWeight: 430,
        fontStyle: "normal",
        lineHeight: 1.5,
        letterSpacing: "0",
        color: fadedColor,
        fontFamily: bodyFont,
      },
      caption: {
        fontSize: 11.2,
        fontWeight: 400,
        fontStyle: "italic",
        lineHeight: 1.42,
        letterSpacing: "0",
        color: "rgba(71, 85, 105, 0.96)",
        fontFamily: bodyFont,
      },
      table: {
        fontSize: 11.8,
        fontWeight: 420,
        fontStyle: "normal",
        lineHeight: 1.4,
        letterSpacing: "0",
        color: "var(--zdt-ink, #0f172a)",
        fontFamily: bodyFont,
      },
      code: {
        fontSize: 11.6,
        fontWeight: 500,
        fontStyle: "normal",
        lineHeight: 1.42,
        letterSpacing: "0",
        color: "var(--zdt-ink, #0f172a)",
        fontFamily: monoFont,
      },
      formula: {
        fontSize: 12,
        fontWeight: 450,
        fontStyle: "italic",
        lineHeight: 1.35,
        letterSpacing: "0",
        color: "var(--zdt-ink, #0f172a)",
        fontFamily: bodyFont,
      },
      header: {
        fontSize: 10.6,
        fontWeight: 450,
        fontStyle: "normal",
        lineHeight: 1.32,
        letterSpacing: "0.01em",
        color: "rgba(71, 85, 105, 0.85)",
        fontFamily: bodyFont,
      },
      footer: {
        fontSize: 10.6,
        fontWeight: 450,
        fontStyle: "normal",
        lineHeight: 1.32,
        letterSpacing: "0.01em",
        color: "rgba(71, 85, 105, 0.85)",
        fontFamily: bodyFont,
      },
      footnote: {
        fontSize: 10.8,
        fontWeight: 420,
        fontStyle: "normal",
        lineHeight: 1.38,
        letterSpacing: "0",
        color: "rgba(71, 85, 105, 0.9)",
        fontFamily: bodyFont,
      },
      reference: {
        fontSize: 11.3,
        fontWeight: 420,
        fontStyle: "normal",
        lineHeight: 1.42,
        letterSpacing: "0",
        color: "rgba(51, 65, 85, 0.92)",
        fontFamily: bodyFont,
      },
      other: {
        fontSize: 12.2,
        fontWeight: 430,
        fontStyle: "normal",
        lineHeight: 1.45,
        letterSpacing: "0",
        color: fadedColor,
        fontFamily: bodyFont,
      },
    };

    const preset = presets[type] || presets.paragraph;
    return {
      ...preset,
      fontSize: Math.max(8, Number((preset.fontSize * fontScale).toFixed(2))),
      lineHeight: Math.max(
        1,
        Number((preset.lineHeight * lineSpacing).toFixed(2)),
      ),
    };
  }

  private adjustFontScale(state: ReaderState, delta: number) {
    const current = this.readPrefs().fontScale;
    const next = this.normalizeFontScale(current + delta);
    setPref("fontScale", next.toFixed(2));
    this.logReader(state.reader, `fontScale=${next}`);
    this.renderChrome(state);
    this.renderSecondaryPages(state);
  }

  private adjustLineSpacing(state: ReaderState, delta: number) {
    const current = this.readPrefs().lineSpacing;
    const next = this.normalizeLineSpacing(current + delta);
    setPref("lineSpacing", next.toFixed(2));
    this.logReader(state.reader, `lineSpacing=${next}`);
    this.renderChrome(state);
    this.renderSecondaryPages(state);
  }

  private toFiniteNumber(value: unknown, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private getDocumentFromNode(node: Node) {
    return (
      (node.ownerDocument as Document | null) || (node as unknown as Document)
    );
  }

  private log(message: string) {
    const formatted = `[DualTranslate] ${message}`;
    try {
      Zotero.debug(formatted);
    } catch (_error) {}
    try {
      globalThis.console?.log?.(formatted);
    } catch (_error) {}
  }

  private logError(message: string, error: unknown) {
    const formatted = `[DualTranslate] ${message}: ${this.stringifyError(error)}`;
    try {
      Zotero.debug(formatted);
    } catch (_error) {}
    try {
      globalThis.console?.error?.(formatted);
    } catch (_error) {}
  }

  private logReader(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    message: string,
  ) {
    const itemID =
      (
        reader as _ZoteroTypes.ReaderInstance<"pdf"> & {
          itemID?: number;
          _itemID?: number;
        }
      ).itemID ||
      (reader as _ZoteroTypes.ReaderInstance<"pdf"> & { _itemID?: number })
        ._itemID ||
      "unknown";
    this.log(`reader=${itemID} ${message}`);
  }

  private stringifyError(error: unknown) {
    if (!error) {
      return "Unknown error";
    }
    if (typeof error === "string") {
      return error;
    }
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch (_error) {
      return String(error);
    }
  }
}
