import { clipboard } from "electron/common";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import { Menu, app, desktopCapturer, dialog, session } from "@electron/remote";
import * as remote from "@electron/remote";
import * as Sentry from "@sentry/electron/renderer";

import type { Config } from "../../common/config-util.js";
import * as ConfigUtil from "../../common/config-util.js";
import * as DNDUtil from "../../common/dnd-util.js";
import type { DndSettings } from "../../common/dnd-util.js";
import * as EnterpriseUtil from "../../common/enterprise-util.js";
import { html } from "../../common/html.js";
import * as LinkUtil from "../../common/link-util.js";
import Logger from "../../common/logger-util.js";
import * as Messages from "../../common/messages.js";
import { bundlePath, bundleUrl } from "../../common/paths.js";
import * as t from "../../common/translation-util.js";
import type {
  NavigationItem,
  ServerConfig,
  TabData,
  TabPage,
} from "../../common/types.js";

import FunctionalTab from "./components/functional-tab.js";
import ServerTab from "./components/server-tab.js";
import WebView from "./components/webview.js";
import { AboutView } from "./pages/about.js";
import { PreferenceView } from "./pages/preference/preference.js";
import { initializeTray } from "./tray.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";
import * as DomainUtil from "./utils/domain-util.js";
import ReconnectUtil from "./utils/reconnect-util.js";

Sentry.init({});

type WebviewListener =
  | "webview-reload"
  | "back"
  | "focus"
  | "forward"
  | "zoomIn"
  | "zoomOut"
  | "zoomActualSize"
  | "log-out"
  | "show-keyboard-shortcuts"
  | "tab-devtools";

const logger = new Logger({
  file: "errors.log",
});

type ServerOrFunctionalTab = ServerTab | FunctionalTab;

const defaultIcon = bundleUrl + "resources/mark_icon.png";
const rootWebContents = remote.getCurrentWebContents();

const dingSound = new Audio(
  new URL("resources/sounds/ding.ogg", bundleUrl).href,
);

export class ServerManagerView {
  $tabsContainer: Element;
  $reloadButton: HTMLButtonElement;
  $loadingIndicator: HTMLButtonElement;
  $settingsButton: HTMLButtonElement;
  $webviewsContainer: Element;
  $backButton: HTMLButtonElement;
  $dndButton: HTMLButtonElement;
  $addServerTooltip: HTMLElement;
  $reloadTooltip: HTMLElement;
  $loadingTooltip: HTMLElement;
  $settingsTooltip: HTMLElement;
  $serverIconTooltip: HTMLCollectionOf<HTMLElement>;
  $backTooltip: HTMLElement;
  $dndTooltip: HTMLElement;
  $sidebar: Element;
  $fullscreenPopup: Element;
  $fullscreenEscapeKey: string;
  loading: Set<string>;
  activeTabIndex: number;
  tabs: ServerOrFunctionalTab[];
  functionalTabs: Map<TabPage, number>;
  tabIndex: number;
  presetOrgs: string[];
  preferenceView?: PreferenceView;

  // Элементы для кнопки обновления
  $updateButton: HTMLButtonElement;
  $updateTooltip: HTMLElement;

  constructor() {
    this.$tabsContainer = document.querySelector("#tabs-container")!;

    const $actionsContainer = document.querySelector("#actions-container")!;
    this.$reloadButton = $actionsContainer.querySelector("#reload-action")!;
    this.$loadingIndicator = $actionsContainer.querySelector("#loading-action")!;
    this.$settingsButton = $actionsContainer.querySelector("#settings-action")!;
    this.$webviewsContainer = document.querySelector("#webviews-container")!;
    this.$backButton = $actionsContainer.querySelector("#back-action")!;
    this.$dndButton = $actionsContainer.querySelector("#dnd-action")!;

    // Инициализация кнопки обновления
    this.$updateButton = $actionsContainer.querySelector("#update-action")!;
    this.$updateTooltip = $actionsContainer.querySelector("#update-tooltip")!;

    this.$addServerTooltip = document.querySelector("#add-server-tooltip")!;
    this.$reloadTooltip = $actionsContainer.querySelector("#reload-tooltip")!;
    this.$loadingTooltip = $actionsContainer.querySelector("#loading-tooltip")!;
    this.$settingsTooltip = $actionsContainer.querySelector("#setting-tooltip")!;

    this.$serverIconTooltip = document.getElementsByClassName(
      "server-tooltip",
    ) as HTMLCollectionOf<HTMLElement>;
    this.$backTooltip = $actionsContainer.querySelector("#back-tooltip")!;
    this.$dndTooltip = $actionsContainer.querySelector("#dnd-tooltip")!;

    this.$sidebar = document.querySelector("#sidebar")!;

    this.$fullscreenPopup = document.querySelector("#fullscreen-popup")!;
    this.$fullscreenEscapeKey = process.platform === "darwin" ? "^⌘F" : "F11";
    this.$fullscreenPopup.textContent = `Нажмите ${this.$fullscreenEscapeKey} для выхода из полноэкранного режима`;

    this.loading = new Set();
    this.activeTabIndex = -1;
    this.tabs = [];
    this.presetOrgs = [];
    this.functionalTabs = new Map();
    this.tabIndex = 0;
  }

  async init(): Promise<void> {
    // Показываем индикатор загрузки
    const loadingIndicator = document.getElementById("loading-indicator");
    if (loadingIndicator) {
      loadingIndicator.style.display = "flex";
    }
  
    // Выполняем асинхронные операции параллельно
    await Promise.all([
      (async () => {
        initializeTray(this);
      })(),
      (async () => {
        await this.loadProxy();
      })(),
      (async () => {
        this.initDefaultSettings();
        this.initSidebar();
        this.removeUaFromDisk();
      })(),
    ]);
  
    await this.initTabs();
    this.initActions();
    this.registerIpcs();
  
    // Скрываем индикатор загрузки
    if (loadingIndicator) {
      loadingIndicator.style.display = "none";
    }
  }

  async loadProxy(): Promise<void> {
    const proxyEnabledOld = ConfigUtil.isConfigItemExists("useProxy");
    if (proxyEnabledOld) {
      const proxyEnableOldState = ConfigUtil.getConfigItem("useProxy", false);
      if (proxyEnableOldState) {
        ConfigUtil.setConfigItem("useManualProxy", true);
      }
      ConfigUtil.removeConfigItem("useProxy");
    }

    await session.fromPartition("persist:webviewsession").setProxy(
      ConfigUtil.getConfigItem("useSystemProxy", false)
        ? { mode: "system" }
        : ConfigUtil.getConfigItem("useManualProxy", false)
        ? {
            pacScript: ConfigUtil.getConfigItem("proxyPAC", ""),
            proxyRules: ConfigUtil.getConfigItem("proxyRules", ""),
            proxyBypassRules: ConfigUtil.getConfigItem("proxyBypass", ""),
          }
        : { mode: "direct" }
    );
  }

  initDefaultSettings(): void {
    const settingOptions: Partial<Config> = {
      autoHideMenubar: false,
      trayIcon: true,
      useManualProxy: false,
      useSystemProxy: false,
      showSidebar: true,
      badgeOption: true,
      startAtLogin: false,
      startMinimized: false,
      enableSpellchecker: true,
      showNotification: true,
      autoUpdate: true,
      betaUpdate: false,
      errorReporting: true,
      customCSS: false,
      silent: false,
      lastActiveTab: 0,
      dnd: false,
      dndPreviousSettings: {
        showNotification: true,
        silent: false,
      },
      downloadsPath: `${app.getPath("downloads")}`,
      quitOnClose: false,
      promptDownload: false,
    };

    if (process.platform === "win32") {
      settingOptions.flashTaskbarOnMessage = true;
      settingOptions.dndPreviousSettings!.flashTaskbarOnMessage = true;
    }

    if (process.platform === "darwin") {
      settingOptions.dockBouncing = true;
    }

    if (process.platform !== "darwin") {
      settingOptions.autoHideMenubar = false;
      settingOptions.spellcheckerLanguages = ["en-US"];
    }

    for (const [setting, value] of Object.entries(settingOptions) as Array<
      { [Key in keyof Config]: [Key, Config[Key]] }[keyof Config]
    >) {
      if (EnterpriseUtil.configItemExists(setting)) {
        ConfigUtil.setConfigItem(
          setting,
          EnterpriseUtil.getConfigItem(setting, value),
          true
        );
      } else if (!ConfigUtil.isConfigItemExists(setting)) {
        ConfigUtil.setConfigItem(setting, value);
      }
    }
  }

  initSidebar(): void {
    const showSidebar = ConfigUtil.getConfigItem("showSidebar", true);
    this.toggleSidebar(showSidebar);
  }

  removeUaFromDisk(): void {
    ConfigUtil.removeConfigItem("userAgent");
  }

  async queueDomain(domain: string): Promise<boolean> {
    try {
      const serverConfig = await DomainUtil.checkDomain(domain);
      await DomainUtil.addDomain(serverConfig);
      return true;
    } catch (error: unknown) {
      logger.error(error);
      logger.error(
        `Не удалось добавить ${domain}. Пожалуйста, свяжитесь с системным администратором.`
      );
      return false;
    }
  }

  async initTabs(): Promise<void> {
    const server = {
      url: "https://joinrm-svz.ru",
      alias: "Цифровые технологии РМ",
      icon: "https://disk.yandex.ru/i/m2aj56OOhsJfyw",
      zulipVersion: app.getVersion()
    } as ServerConfig;
  
    DomainUtil.removeDomains();
    const tab = this.initServer(server, 0);
    DomainUtil.addDomain(server);
  
    // Устанавливаем метку сразу
    tab.setLabel(server.alias);
  
    // Откладываем загрузку иконки
    setTimeout(async () => {
      try {
        const iconUrl = await DomainUtil.saveServerIcon(server.icon);
        tab.setIcon(DomainUtil.iconAsUrl(iconUrl));
      } catch (error) {
        console.log("Ошибка загрузки иконки сервера:", error);
        tab.setIcon(DomainUtil.iconAsUrl("https://connectrm-svz.ru//user_avatars/2/realm/night_logo.png?version=2"));
      }
    }, 0);
  
    await this.activateTab(0);
  }

  initServer(server: ServerConfig, index: number): ServerTab {
    console.log("$webviewsContainer:", this.$webviewsContainer);
    console.log("server.url:", server.url);
    console.log("preload:", url.pathToFileURL(path.join(bundlePath, "preload.js")).href);

    const tabIndex = this.getTabIndex();

    const webView = WebView.create({
      $root: this.$webviewsContainer,
      rootWebContents,
      index,
      tabIndex,
      url: server.url,
      role: "server",
      hasPermission: (origin: string, permission: string) => true,
      isActive: () => index === this.activeTabIndex,
      switchLoading: async (loading: boolean, url: string) => {
        if (loading) {
          this.loading.add(url);
        } else {
          this.loading.delete(url);
        }

        const tab = this.tabs[this.activeTabIndex];
        this.showLoading(
          tab instanceof ServerTab &&
          this.loading.has((await tab.webview).properties.url)
        );
      },
      onNetworkError: async (index: number) => {
        await this.openNetworkTroubleshooting(index);
      },
      onTitleChange: this.updateBadge.bind(this),
      preload: url.pathToFileURL(path.join(bundlePath, "preload.js")).href,
      unsupportedMessage: DomainUtil.getUnsupportedMessage(server),
    });

    const tab = new ServerTab({
      role: "server",
      icon: DomainUtil.iconAsUrl(server.icon),
      label: server.alias,
      $root: this.$tabsContainer,
      onClick: this.activateLastTab.bind(this, index),
      index,
      tabIndex,
      onHover: this.onHover.bind(this, index),
      onHoverOut: this.onHoverOut.bind(this, index),
      webview: webView,
    });
    this.tabs.push(tab);
    this.loading.add(server.url);
    return tab;
  }

  initActions(): void {
    this.initDndButton();
    this.initServerActions();
    this.initLeftSidebarEvents();
  }

  initServerActions(): void {
    const $serverImgs: NodeListOf<HTMLImageElement> =
      document.querySelectorAll(".server-icons");
    for (const [index, $serverImg] of $serverImgs.entries()) {
      this.addContextMenu($serverImg, index);
      if ($serverImg.src === defaultIcon) {
        this.displayInitialCharLogo($serverImg, index);
      }

      $serverImg.addEventListener("error", () => {
        this.displayInitialCharLogo($serverImg, index);
      });
    }
  }

  initLeftSidebarEvents(): void {
    this.$dndButton.addEventListener("click", () => {
      const dndUtil = DNDUtil.toggle();
      ipcRenderer.send(
        "forward-message",
        "toggle-dnd",
        dndUtil.dnd,
        dndUtil.newSettings
      );
    });
    this.$reloadButton.addEventListener("click", async () => {
      const tab = this.tabs[this.activeTabIndex];
      if (tab instanceof ServerTab) (await tab.webview).reload();
    });
    this.$settingsButton.addEventListener("click", async () => {
      await this.openSettings("General");
    });
    this.$backButton.addEventListener("click", async () => {
      const tab = this.tabs[this.activeTabIndex];
      if (tab instanceof ServerTab) (await tab.webview).back();
    });

    // Добавляем обработчик для кнопки обновления
    // this.$updateButton.addEventListener("click", () => {
    //   ipcRenderer.send("restart_app");
    // });

    this.sidebarHoverEvent(this.$loadingIndicator, this.$loadingTooltip);
    this.sidebarHoverEvent(this.$settingsButton, this.$settingsTooltip);
    this.sidebarHoverEvent(this.$reloadButton, this.$reloadTooltip);
    this.sidebarHoverEvent(this.$backButton, this.$backTooltip);
    this.sidebarHoverEvent(this.$dndButton, this.$dndTooltip);
    // this.sidebarHoverEvent(this.$updateButton, this.$updateTooltip);
  }

  initDndButton(): void {
    const dnd = ConfigUtil.getConfigItem("dnd", false);
    this.toggleDndButton(dnd);
  }

  getTabIndex(): number {
    const currentIndex = this.tabIndex;
    this.tabIndex++;
    return currentIndex;
  }

  async getCurrentActiveServer(): Promise<string> {
    const tab = this.tabs[this.activeTabIndex];
    return tab instanceof ServerTab ? (await tab.webview).properties.url : "";
  }

  displayInitialCharLogo($img: HTMLImageElement, index: number): void {
    const $altIcon = document.createElement("div");
    const $parent = $img.parentElement!;
    const $container = $parent.parentElement!;
    const webviewId = $container.dataset.tabId!;
    const $webview = document.querySelector(
      `webview[data-tab-id="${CSS.escape(webviewId)}"]`
    )!;
    const realmName = $webview.getAttribute("name");

    if (realmName === null) {
      $img.src = defaultIcon;
      return;
    }

    $altIcon.textContent = realmName.charAt(0) || "Z";
    $altIcon.classList.add("server-icon");
    $altIcon.classList.add("alt-icon");

    $img.remove();
    $parent.append($altIcon);

    this.addContextMenu($altIcon, index);
  }

  sidebarHoverEvent(
    SidebarButton: HTMLButtonElement,
    SidebarTooltip: HTMLElement,
    addServer = false
  ): void {
    SidebarButton.addEventListener("mouseover", () => {
      SidebarTooltip.removeAttribute("style");
      if (addServer) {
        const { top } = SidebarButton.getBoundingClientRect();
        SidebarTooltip.style.top = `${top}px`;
      }
    });
    SidebarButton.addEventListener("mouseout", () => {
      SidebarTooltip.style.display = "none";
    });
  }

  onHover(index: number): void {
    this.$serverIconTooltip[index].removeAttribute("style");
    const { top } =
      this.$serverIconTooltip[index].parentElement!.getBoundingClientRect();
    this.$serverIconTooltip[index].style.top = `${top}px`;
  }

  onHoverOut(index: number): void {
    this.$serverIconTooltip[index].style.display = "none";
  }

  async openFunctionalTab(tabProperties: {
    label: string;
    page: TabPage;
    materialIcon: string;
    makeView: () => Promise<Element>;
    destroyView: () => void;
  }): Promise<void> {
    if (this.functionalTabs.has(tabProperties.page)) {
      await this.activateTab(this.functionalTabs.get(tabProperties.page)!);
      return;
    }

    const index = this.tabs.length;
    this.functionalTabs.set(tabProperties.page, index);

    const tabIndex = this.getTabIndex();
    const $view = await tabProperties.makeView();
    this.$webviewsContainer.append($view);

    this.tabs.push(
      new FunctionalTab({
        role: "function",
        materialIcon: tabProperties.materialIcon,
        label: tabProperties.label,
        page: tabProperties.page,
        $root: this.$tabsContainer,
        index,
        tabIndex,
        onClick: this.activateTab.bind(this, index),
        onDestroy: async () => {
          await this.destroyFunctionalTab(tabProperties.page, index);
          tabProperties.destroyView();
        },
        $view,
      })
    );

    this.$webviewsContainer.classList.remove("loaded");
    await this.activateTab(this.functionalTabs.get(tabProperties.page)!);
  }

  async openSettings(navigationItem: NavigationItem = "General"): Promise<void> {
    await this.openFunctionalTab({
      page: "Settings",
      label: t.__("Настройки"),
      materialIcon: "settings",
      makeView: async () => {
        this.preferenceView = await PreferenceView.create();
        this.preferenceView.$view.classList.add("functional-view");
        return this.preferenceView.$view;
      },
      destroyView: () => {
        this.preferenceView!.destroy();
        this.preferenceView = undefined;
      },
    });
    this.$settingsButton.classList.add("active");
    this.preferenceView!.handleNavigation(navigationItem);
  }

  async openAbout(): Promise<void> {
    let aboutView: AboutView;
    await this.openFunctionalTab({
      page: "About",
      label: t.__("О программе"),
      materialIcon: "sentiment_very_satisfied",
      async makeView() {
        aboutView = await AboutView.create();
        aboutView.$view.classList.add("functional-view");
        return aboutView.$view;
      },
      destroyView() {
        aboutView.destroy();
      },
    });
  }

  async openNetworkTroubleshooting(index: number): Promise<void> {
    const tab = this.tabs[index];
    if (!(tab instanceof ServerTab)) return;
    const webview = await tab.webview;
    const reconnectUtil = new ReconnectUtil(webview);
    reconnectUtil.pollInternetAndReload();
    await webview
      .getWebContents()
      .loadURL(new URL("app/renderer/network.html", bundleUrl).href);
  }

  async activateLastTab(index: number): Promise<void> {
    await this.activateTab(index);
    ipcRenderer.send("save-last-tab", index);
  }

  get tabsForIpc(): TabData[] {
    return this.tabs.map((tab) => ({
      role: tab.properties.role,
      page: tab.properties.page,
      label: tab.properties.label,
      index: tab.properties.index,
    }));
  }

  async activateTab(index: number, hideOldTab = true): Promise<void> {
    const tab = this.tabs[index];
    if (!tab) return;

    if (this.activeTabIndex !== -1) {
      if (this.activeTabIndex === index) return;
      if (hideOldTab) {
        if (
          this.tabs[this.activeTabIndex].properties.role === "function" &&
          this.tabs[this.activeTabIndex].properties.page === "Settings"
        ) {
          this.$settingsButton.classList.remove("active");
        }
        await this.tabs[this.activeTabIndex].deactivate();
      }
    }

    if (tab instanceof ServerTab) {
      try {
        (await tab.webview).canGoBackButton();
      } catch {}
    } else {
      document
        .querySelector("#actions-container #back-action")!
        .classList.add("disable");
    }

    this.activeTabIndex = index;
    await tab.activate();

    this.showLoading(
      tab instanceof ServerTab &&
      this.loading.has((await tab.webview).properties.url)
    );

    ipcRenderer.send("update-menu", {
      tabs: this.tabsForIpc,
      activeTabIndex: this.activeTabIndex,
      enableMenu: tab.properties.role === "server",
    });
  }

  showLoading(loading: boolean): void {
    this.$reloadButton.classList.toggle("hidden", loading);
    this.$loadingIndicator.classList.toggle("hidden", !loading);
  }

  async destroyFunctionalTab(page: TabPage, index: number): Promise<void> {
    const tab = this.tabs[index];
    if (tab instanceof ServerTab && (await tab.webview).loading) return;

    await tab.destroy();
    delete this.tabs[index];
    this.functionalTabs.delete(page);

    if (this.activeTabIndex === index) {
      await this.activateTab(0, false);
    }
  }

  destroyView(): void {
    this.$webviewsContainer.classList.remove("loaded");
    this.activeTabIndex = -1;
    this.tabs = [];
    this.functionalTabs.clear();
    this.$tabsContainer.textContent = "";
    this.$webviewsContainer.textContent = "";
  }

  async reloadView(): Promise<void> {
    const lastActiveTab = this.tabs[this.activeTabIndex].properties.index;
    ConfigUtil.setConfigItem("lastActiveTab", lastActiveTab);
    this.destroyView();
    await this.initTabs();
    this.initServerActions();
  }

  reloadCurrentView(): void {
    this.$reloadButton.click();
  }

  async updateBadge(): Promise<void> {
    let messageCountAll = 0;
    await Promise.all(
      this.tabs.map(async (tab) => {
        if (tab && tab instanceof ServerTab && tab.updateBadge) {
          const count = (await tab.webview).badgeCount;
          messageCountAll += count;
          tab.updateBadge(count);
        }
      })
    );
    ipcRenderer.send("update-badge", messageCountAll);
  }

  toggleSidebar(show: boolean): void {
    this.$sidebar.classList.toggle("sidebar-hide", !show);
  }

  toggleDndButton(alert: boolean): void {
    this.$dndTooltip.textContent =
      (alert ? "Отключить" : "Включить") + " Не беспокоить";
    this.$dndButton.querySelector("i")!.textContent = alert
      ? "notifications_off"
      : "notifications";
  }

  async isLoggedIn(tabIndex: number): Promise<boolean> {
    const tab = this.tabs[tabIndex];
    if (!(tab instanceof ServerTab)) return false;
    const webview = await tab.webview;
    const url = webview.getWebContents().getURL();
    return !(url.endsWith("/login/") || webview.loading);
  }

  addContextMenu($serverImg: HTMLElement, index: number): void {
    $serverImg.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      const template = [
        {
          label: t.__("Настройки уведомлений"),
          enabled: await this.isLoggedIn(index),
          click: async () => {
            await this.activateTab(index);
            const tab = this.tabs[index];
            if (tab instanceof ServerTab)
              (await tab.webview).showNotificationSettings();
          },
        },
        {
          label: t.__("Копировать URL RM"),
          click() {
            clipboard.writeText(DomainUtil.getDomain(index).url);
          },
        },
      ];
      const contextMenu = Menu.buildFromTemplate(template);
      contextMenu.popup({ window: remote.getCurrentWindow() });
    });
  }

  registerIpcs(): void {
    const webviewListeners: Array<[WebviewListener, (webview: WebView) => void]> = [
      ["webview-reload", (webview) => { webview.reload(); }],
      ["back", (webview) => { webview.back(); }],
      ["focus", (webview) => { webview.focus(); }],
      ["forward", (webview) => { webview.forward(); }],
      ["zoomIn", (webview) => { webview.zoomIn(); }],
      ["zoomOut", (webview) => { webview.zoomOut(); }],
      ["zoomActualSize", (webview) => { webview.zoomActualSize(); }],
      ["log-out", (webview) => { webview.logOut(); }],
      ["show-keyboard-shortcuts", (webview) => { webview.showKeyboardShortcuts(); }],
      ["tab-devtools", (webview) => { webview.openDevTools(); }],
    ];
  
    for (const [channel, listener] of webviewListeners) {
      ipcRenderer.on(channel, async () => {
        const tab = this.tabs[this.activeTabIndex];
        if (tab instanceof ServerTab) {
          const activeWebview = await tab.webview;
          if (activeWebview) listener(activeWebview);
        }
      });
    }

    ipcRenderer.on("quit-app", () => {
      console.log("Renderer: Получено событие quit-app, перенаправление в основной процесс");
      ipcRenderer.send("quit-app");
    });

    ipcRenderer.on("permission-request", async (
      event,
      { webContentsId, origin, permission }: { webContentsId: number | null; origin: string; permission: string },
      permissionCallbackId: number,
    ) => {
      ipcRenderer.send("permission-callback", permissionCallbackId, true);
    });

    ipcRenderer.on("open-settings", async () => { await this.openSettings(); });
    ipcRenderer.on("open-about", this.openAbout.bind(this));
    ipcRenderer.on("reload-viewer", this.reloadView.bind(this));
    ipcRenderer.on("reload-current-viewer", this.reloadCurrentView.bind(this));
    ipcRenderer.on("hard-reload", () => { ipcRenderer.send("reload-full-app"); });
    ipcRenderer.on("switch-server-tab", async (event, index: number) => { await this.activateLastTab(index); });
    ipcRenderer.on("reload-proxy", async (event, showAlert: boolean) => {
      await this.loadProxy();
      if (showAlert) {
        await dialog.showMessageBox({ message: t.__("Настройки прокси сохранены."), buttons: [t.__("OK")] });
        ipcRenderer.send("reload-full-app");
      }
    });
    ipcRenderer.on("toggle-sidebar", async (event, show: boolean) => { this.toggleSidebar(show); });
    ipcRenderer.on("toggle-silent", async (event, state: boolean) =>
      Promise.all(this.tabs.map(async (tab) => {
        if (tab instanceof ServerTab) (await tab.webview).getWebContents().setAudioMuted(state);
      })),
    );
    ipcRenderer.on("toggle-autohide-menubar", async (event, autoHideMenubar: boolean, updateMenu: boolean) => {
      if (updateMenu) {
        ipcRenderer.send("update-menu", { tabs: this.tabsForIpc, activeTabIndex: this.activeTabIndex });
      }
    });
    ipcRenderer.on("toggle-dnd", async (event, state: boolean, newSettings: Partial<DndSettings>) => {
      this.toggleDndButton(state);
      ipcRenderer.send("forward-message", "toggle-silent", newSettings.silent ?? false);
    });
    ipcRenderer.on("update-realm-name", (event, serverURL: string, realmName: string) => {
      for (const [index, domain] of DomainUtil.getDomains().entries()) {
        if (domain.url === serverURL) {
          const tab = this.tabs[index];
          if (tab instanceof ServerTab) tab.setLabel(realmName);
          domain.alias = realmName;
          DomainUtil.updateDomain(index, domain);
          ipcRenderer.send("update-menu", { tabs: this.tabsForIpc, activeTabIndex: this.activeTabIndex });
        }
      }
    });
    ipcRenderer.on("update-realm-icon", async (event, serverURL: string, iconURL: string) => {
      await Promise.all(DomainUtil.getDomains().map(async (domain, index) => {
        if (domain.url === serverURL) {
          const localIconPath = await DomainUtil.saveServerIcon(iconURL);
          const tab = this.tabs[index];
          if (tab instanceof ServerTab) tab.setIcon(DomainUtil.iconAsUrl(localIconPath));
          domain.icon = localIconPath;
          DomainUtil.updateDomain(index, domain);
        }
      }));
    });
    ipcRenderer.on("enter-fullscreen", () => {
      this.$fullscreenPopup.classList.add("show");
      this.$fullscreenPopup.classList.remove("hidden");
    });
    ipcRenderer.on("leave-fullscreen", () => { this.$fullscreenPopup.classList.remove("show"); });
    ipcRenderer.on("focus-webview-with-id", async (event, webviewId: number) =>
      Promise.all(this.tabs.map(async (tab) => {
        if (tab instanceof ServerTab && (await tab.webview).webContentsId === webviewId) {
          const concurrentTab: HTMLButtonElement = document.querySelector(
            `div[data-tab-id="${CSS.escape(`${tab.properties.tabIndex}`)}"]`,
          )!;
          concurrentTab.click();
        }
      })),
    );
    ipcRenderer.on("render-taskbar-icon", (event, messageCount: number) => {
      function createOverlayIcon(messageCount: number): HTMLCanvasElement {
        const canvas = document.createElement("canvas");
        canvas.height = 128;
        canvas.width = 128;
        canvas.style.letterSpacing = "-5px";
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#f42020";
        context.beginPath();
        context.ellipse(64, 64, 64, 64, 0, 0, 2 * Math.PI);
        context.fill();
        context.textAlign = "center";
        context.fillStyle = "white";
        if (messageCount > 99) {
          context.font = "65px Helvetica";
          context.fillText("99+", 64, 85);
        } else if (messageCount < 10) {
          context.font = "90px Helvetica";
          context.fillText(String(Math.min(99, messageCount)), 64, 96);
        } else {
          context.font = "85px Helvetica";
          context.fillText(String(Math.min(99, messageCount)), 64, 90);
        }
        return canvas;
      }
      ipcRenderer.send("update-taskbar-icon", createOverlayIcon(messageCount).toDataURL(), String(messageCount));
    });
    ipcRenderer.on("copy-rm-url", async () => { clipboard.writeText(await this.getCurrentActiveServer()); });
    ipcRenderer.on("set-active", async () =>
      Promise.all(this.tabs.map(async (tab) => {
        if (tab instanceof ServerTab) (await tab.webview).send("set-active");
      })),
    );
    ipcRenderer.on("set-idle", async () =>
      Promise.all(this.tabs.map(async (tab) => {
        if (tab instanceof ServerTab) (await tab.webview).send("set-idle");
      })),
    );
    ipcRenderer.on("open-network-settings", async () => { await this.openSettings("Network"); });
    ipcRenderer.on("play-ding-sound", async () => { await dingSound.play(); });

    // Обработчики для автообновления
    ipcRenderer.on("update_available", (event, version: string) => {
      this.$updateTooltip.innerText = `Доступно: v${version}`;
      this.$updateButton.classList.remove("hidden");
    });

    ipcRenderer.on("update_progress", (event, percent: number) => {
      this.$updateTooltip.innerText = `Загрузка: ${~~percent}%`;
      this.$updateButton.classList.remove("hidden");
    });

    ipcRenderer.on("update_downloaded", () => {
      this.$updateTooltip.innerText = "Готово!";
      this.$updateButton.classList.remove("hidden");
    });

    ipcRenderer.on("update_error", (event, message: string) => {
      this.$updateTooltip.innerText = `Ошибка: ${message}`;
      this.$updateButton.classList.remove("hidden");
    });
  }
}

// Replace your entire window.addEventListener("load", ...) section with this clean version
// This removes all the problematic window checks and focuses on the working remote API

window.addEventListener("load", async () => {
  const appVersion = app.getVersion();
  document.body.innerHTML = html`
    <style>
      .version-label {
        color: white;
        opacity: 0.25;
        margin-left: 7px;
      }
    </style>
    <div id="content">
      <div class="popup">
        <span class="popuptext hidden" id="fullscreen-popup"></span>
      </div>
      <div id="sidebar" class="toggle-sidebar">
        <div id="view-controls-container">
          <div id="tabs-container"></div>
        </div>
        <div id="actions-container">
          <div class="action-button" id="dnd-action">
            <i class="material-icons md-48">notifications</i>
            <span id="dnd-tooltip" style="display: none">${t.__("Не беспокоить")}</span>
          </div>
          <div class="action-button hidden" id="reload-action">
            <i class="material-icons md-48">refresh</i>
            <span id="reload-tooltip" style="display: none">${t.__("Перезагрузить")}</span>
          </div>
          <div class="action-button disable" id="loading-action">
            <i class="refresh material-icons md-48">loop</i>
            <span id="loading-tooltip" style="display: none">${t.__("Загрузка")}</span>
          </div>
          <div class="action-button disable" id="back-action">
            <i class="material-icons md-48">arrow_back</i>
            <span id="back-tooltip" style="display: none">${t.__("Назад")}</span>
          </div>
          <div class="action-button" id="settings-action">
            <i class="material-icons md-48">settings</i>
            <span id="setting-tooltip" style="display: none">${t.__("Настройки")}</span>
          </div>
          <div class="version-label">${appVersion}</div>
        </div>
      </div>
      <div id="main-container">
        <div id="webviews-container"></div>
      </div>
    </div>
  `.html;

  const serverManagerView = new ServerManagerView();
  await serverManagerView.init();

  // Only create the remote API test - this is the one that works
  // Replace your createRemoteTest function with this version that uses your existing ipcRenderer

  function createRemoteTest() {
    console.log('🔍 Creating screen capture test button...');
    
    const testButton = document.createElement('button');
    testButton.id = 'screen-capture-test';
    testButton.innerHTML = '📹 Test Screen Capture Addon';
    testButton.style.cssText = `
      position: fixed;
      top: 60px;
      right: 20px;
      z-index: 10000;
      padding: 12px 18px;
      background: #28a745;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 3px 6px rgba(0,0,0,0.2);
    `;
    
    testButton.addEventListener('click', async () => {
      console.log('📹 Test button clicked!');
      testButton.innerHTML = '⏳ Testing...';
      testButton.disabled = true;
      
      try {
        // Use your existing typed ipcRenderer that's already imported
        console.log('✅ Using existing typed ipcRenderer');
        console.log('ipcRenderer type:', typeof ipcRenderer);
        console.log('ipcRenderer.invoke type:', typeof ipcRenderer.invoke);
        
        // Test the screen capture addon directly
        const result = await ipcRenderer.invoke('screen-capture-test');
        console.log('✅ Test result:', result);
        
        if (result && result.success) {
          testButton.innerHTML = '✅ Addon Works!';
          testButton.style.background = '#28a745';
          
          // Show success message
          alert(`✅ Screen Capture Addon Works!\n\nResult: ${result.result}`);
          
        } else {
          testButton.innerHTML = '❌ Test Failed';
          testButton.style.background = '#dc3545';
          alert(`❌ Test failed: ${result ? result.error : 'Unknown error'}`);
        }
        
      } catch (error) {
        console.error('❌ Error in test:', error);
        testButton.innerHTML = '❌ Error';
        testButton.style.background = '#dc3545';
        alert(`❌ Error: ${error.message}`);
      }
      
      // Reset button after 5 seconds
      setTimeout(() => {
        testButton.innerHTML = '📹 Test Screen Capture Addon';
        testButton.style.background = '#28a745';
        testButton.disabled = false;
      }, 5000);
    });
    
    document.body.appendChild(testButton);
    console.log('✅ Screen capture test button added');
  }

  // Also create a webview test using your existing system
  function createWebviewTest() {
    const testButton = document.createElement('button');
    testButton.id = 'webview-test';
    testButton.innerHTML = '📧 Test Webview Context';
    testButton.style.cssText = `
      position: fixed;
      top: 110px;
      right: 20px;
      z-index: 10000;
      padding: 12px 18px;
      background: #fd7e14;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 3px 6px rgba(0,0,0,0.2);
    `;
    
    testButton.addEventListener('click', async () => {
      console.log('📧 Webview test clicked!');
      testButton.innerHTML = '⏳ Sending...';
      testButton.disabled = true;
      
      try {
        // Send forward-message to trigger test in webview
        // This uses your existing system like the desktop picker
        ipcRenderer.send('forward-message', 'test-screen-capture-in-webview');
        console.log('✅ Message sent to webview context');
        
        testButton.innerHTML = '✅ Message Sent';
        testButton.style.background = '#28a745';
        
      } catch (error) {
        console.error('❌ Error sending message:', error);
        testButton.innerHTML = '❌ Error';
        testButton.style.background = '#dc3545';
      }
      
      // Reset button after 3 seconds
      setTimeout(() => {
        testButton.innerHTML = '📧 Test Webview Context';
        testButton.style.background = '#fd7e14';
        testButton.disabled = false;
      }, 3000);
    });
    
    document.body.appendChild(testButton);
    console.log('✅ Webview test button added');
  }

  // Create both test buttons
  // createRemoteTest();
  // createWebviewTest();



  // Add this to your main.ts to test the complete screen capture pipeline

  function createScreenCapturePipelineTest() {
    console.log('🔍 Creating screen capture pipeline test...');
    
    // Create a container for all test controls
    const testContainer = document.createElement('div');
    testContainer.id = 'screen-capture-test-container';
    testContainer.style.cssText = `
      position: fixed;
      top: 60px;
      right: 20px;
      z-index: 10000;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 15px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      min-width: 300px;
      font-family: system-ui, -apple-system, sans-serif;
    `;
    
    // Title
    const title = document.createElement('h3');
    title.innerHTML = '📹 Screen Capture Test';
    title.style.cssText = 'margin: 0 0 15px 0; font-size: 16px;';
    testContainer.appendChild(title);
    
    // Status display
    const statusDiv = document.createElement('div');
    statusDiv.id = 'capture-status';
    statusDiv.innerHTML = '🔴 Not capturing';
    statusDiv.style.cssText = 'margin-bottom: 15px; font-size: 14px; font-weight: bold;';
    testContainer.appendChild(statusDiv);
    
    // Frame counter
    const frameCounter = document.createElement('div');
    frameCounter.id = 'frame-counter';
    frameCounter.innerHTML = 'Frames: 0';
    frameCounter.style.cssText = 'margin-bottom: 15px; font-size: 12px; color: #ccc;';
    testContainer.appendChild(frameCounter);
    
    // Source selector
    const sourceLabel = document.createElement('label');
    sourceLabel.innerHTML = 'Screen Source:';
    sourceLabel.style.cssText = 'display: block; margin-bottom: 5px; font-size: 12px;';
    testContainer.appendChild(sourceLabel);
    
    const sourceSelect = document.createElement('select');
    sourceSelect.id = 'source-select';
    sourceSelect.style.cssText = `
      width: 100%;
      padding: 5px;
      margin-bottom: 15px;
      border: 1px solid #555;
      background: #333;
      color: white;
      border-radius: 4px;
    `;
    sourceSelect.innerHTML = '<option value="">Loading sources...</option>';
    testContainer.appendChild(sourceSelect);
    
    // Control buttons
    const buttonsDiv = document.createElement('div');
    buttonsDiv.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap;';
    
    // Get Sources button
    const getSourcesBtn = document.createElement('button');
    getSourcesBtn.innerHTML = '🔍 Get Sources';
    getSourcesBtn.style.cssText = `
      padding: 8px 12px;
      background: #007bff;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    `;
    buttonsDiv.appendChild(getSourcesBtn);
    
    // Start Capture button
    const startBtn = document.createElement('button');
    startBtn.innerHTML = '▶️ Start';
    startBtn.style.cssText = `
      padding: 8px 12px;
      background: #28a745;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    `;
    startBtn.disabled = true;
    buttonsDiv.appendChild(startBtn);
    
    // Stop Capture button
    const stopBtn = document.createElement('button');
    stopBtn.innerHTML = '⏹️ Stop';
    stopBtn.style.cssText = `
      padding: 8px 12px;
      background: #dc3545;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    `;
    stopBtn.disabled = true;
    buttonsDiv.appendChild(stopBtn);
    
    // Get Stats button
    const statsBtn = document.createElement('button');
    statsBtn.innerHTML = '📊 Stats';
    statsBtn.style.cssText = `
      padding: 8px 12px;
      background: #6c757d;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    `;
    buttonsDiv.appendChild(statsBtn);
    
    testContainer.appendChild(buttonsDiv);
    
    // Variables to track state
    let isCapturing = false;
    let frameCount = 0;
    let frameInterval = null;
    
    // Update status function
    function updateStatus(status, color = '#fff') {
      statusDiv.innerHTML = status;
      statusDiv.style.color = color;
    }
    
    // Update frame counter
    function updateFrameCounter() {
      frameCounter.innerHTML = `Frames: ${frameCount}`;
    }
    
    // Get Sources button handler
    getSourcesBtn.addEventListener('click', async () => {
      console.log('🔍 Getting screen sources...');
      getSourcesBtn.innerHTML = '⏳ Loading...';
      getSourcesBtn.disabled = true;
      
      try {
        // Use Electron's desktopCapturer to get sources
        const { desktopCapturer } = require('@electron/remote');
        const sources = await desktopCapturer.getSources({
          types: ['window', 'screen'],
          thumbnailSize: { width: 300, height: 300 }
        });
        
        console.log('✅ Found sources:', sources.length);
        
        // Populate the select dropdown
        sourceSelect.innerHTML = '<option value="">Select a source...</option>';
        sources.forEach((source, index) => {
          const option = document.createElement('option');
          option.value = source.id;
          option.textContent = `${source.name} (${source.id.startsWith('screen:') ? 'Screen' : 'Window'})`;
          sourceSelect.appendChild(option);
        });
        
        startBtn.disabled = false;
        updateStatus('📋 Sources loaded - select one to start', '#28a745');
        
      } catch (error) {
        console.error('❌ Error getting sources:', error);
        updateStatus('❌ Failed to get sources', '#dc3545');
      }
      
      getSourcesBtn.innerHTML = '🔍 Get Sources';
      getSourcesBtn.disabled = false;
    });
    
    // Start Capture button handler
    // Replace your start button handler in the pipeline test with this corrected version

    // Start Capture button handler - FIXED VERSION
    startBtn.addEventListener('click', async () => {
      console.log('▶️ Starting capture with native picker...');
      startBtn.innerHTML = '⏳ Starting...';
      startBtn.disabled = true;
      
      try {
        // Don't pass a sourceId - let Swift show its picker
        const result = await ipcRenderer.invoke('screen-capture-start-with-picker');
        
        console.log('✅ Start capture result:', result);
        
        if (result && result.success) {
          isCapturing = true;
          frameCount = 0;
          
          updateStatus('🟢 Capturing...', '#28a745');
          startBtn.disabled = true;
          stopBtn.disabled = false;
          getSourcesBtn.disabled = true;
          sourceSelect.disabled = true;
        } else {
          throw new Error(result ? result.error : 'Unknown error');
        }
        
      } catch (error) {
        console.error('❌ Error starting capture:', error);
        updateStatus('❌ Failed to start capture', '#dc3545');
        alert('❌ Failed to start capture: ' + error.message);
      }
      
      startBtn.innerHTML = '▶️ Start';
      if (!isCapturing) {
        startBtn.disabled = false;
      }
    });

    // Also fix the stop button handler
    stopBtn.addEventListener('click', async () => {
      console.log('⏹️ Stopping capture...');
      stopBtn.innerHTML = '⏳ Stopping...';
      stopBtn.disabled = true;
      
      try {
        // Use the existing ipcRenderer
        const result = await ipcRenderer.invoke('screen-capture-stop');
        console.log('✅ Stop capture result:', result);
        
        if (result && result.success) {
          isCapturing = false;
          
          if (frameInterval) {
            clearInterval(frameInterval);
            frameInterval = null;
          }
          
          updateStatus('🔴 Stopped', '#dc3545');
          startBtn.disabled = false;
          getSourcesBtn.disabled = false;
          sourceSelect.disabled = false;
          
        } else {
          throw new Error(result ? result.error : 'Unknown error');
        }
        
      } catch (error) {
        console.error('❌ Error stopping capture:', error);
        updateStatus('❌ Failed to stop capture', '#dc3545');
        alert('❌ Failed to stop capture: ' + error.message);
      }
      
      stopBtn.innerHTML = '⏹️ Stop';
      stopBtn.disabled = true;
    });

    // And fix the stats button handler
    statsBtn.addEventListener('click', async () => {
      console.log('📊 Getting capture stats...');
      statsBtn.innerHTML = '⏳ Loading...';
      statsBtn.disabled = true;
      
      try {
        // Use the existing ipcRenderer
        const result = await ipcRenderer.invoke('screen-capture-stats');
        console.log('✅ Stats result:', result);
        
        if (result && result.success) {
          const stats = result.stats;
          alert(`📊 Capture Statistics:
          
    📹 Video Frames: ${stats.videoFrames || 0}
    🔊 Audio Frames: ${stats.audioFrames || 0}
    ⚡ Active: ${stats.isActive ? 'Yes' : 'No'}`);
        } else {
          throw new Error(result ? result.error : 'Unknown error');
        }
        
      } catch (error) {
        console.error('❌ Error getting stats:', error);
        alert('❌ Failed to get stats: ' + error.message);
      }
      
      statsBtn.innerHTML = '📊 Stats';
      statsBtn.disabled = false;
    });
    
    document.body.appendChild(testContainer);
    console.log('✅ Screen capture pipeline test UI created');
    
    // Auto-load sources on startup
    setTimeout(() => {
      getSourcesBtn.click();
    }, 1000);
  }

  // Create the pipeline test UI
  // createScreenCapturePipelineTest();

  // Update your setupFrameReceiver function in main.ts

  function setupFrameReceiver() {
    console.log('🎬 Setting up enhanced frame receiver...');
    
    // Create frame log display
    const frameLogDiv = document.createElement('div');
    frameLogDiv.id = 'frame-log';
    frameLogDiv.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 10000;
      background: rgba(0, 0, 0, 0.9);
      color: #00ff00;
      padding: 10px;
      border-radius: 6px;
      font-family: 'Courier New', monospace;
      font-size: 11px;
      max-height: 300px;
      overflow-y: auto;
      width: 450px;
      border: 1px solid #333;
    `;
    
    const logTitle = document.createElement('div');
    logTitle.innerHTML = '📹 Live Frame Stream';
    logTitle.style.cssText = 'color: white; font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid #333; padding-bottom: 5px; text-align: center;';
    frameLogDiv.appendChild(logTitle);
    
    // Statistics display
    const statsDiv = document.createElement('div');
    statsDiv.id = 'frame-stats';
    statsDiv.style.cssText = 'color: #ffd700; font-size: 10px; margin-bottom: 8px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px;';
    frameLogDiv.appendChild(statsDiv);
    
    const logContent = document.createElement('div');
    logContent.id = 'frame-log-content';
    logContent.style.cssText = 'max-height: 200px; overflow-y: auto;';
    frameLogDiv.appendChild(logContent);
    
    document.body.appendChild(frameLogDiv);
    
    // Frame statistics
    let totalVideoFrames = 0;
    let totalAudioFrames = 0;
    let lastFrameTime = 0;
    let videoFrameRate = 0;
    let audioFrameRate = 0;
    let videoFrameCounter = 0;
    let audioFrameCounter = 0;
    let lastVideoSize = 0;
    let lastAudioChannels = 0;
    let lastAudioSampleRate = 0;
    
    // Calculate frame rates every second
    setInterval(() => {
      videoFrameRate = videoFrameCounter;
      audioFrameRate = audioFrameCounter;
      videoFrameCounter = 0;
      audioFrameCounter = 0;
      
      // Update statistics display
      statsDiv.innerHTML = `
        <div>📹 Video: ${totalVideoFrames} frames (${videoFrameRate} FPS)</div>
        <div>🔊 Audio: ${totalAudioFrames} frames (${audioFrameRate} FPS)</div>
        <div>📏 Resolution: ${lastVideoSize > 0 ? lastVideoSize : 'N/A'}</div>
        <div>🎵 Audio: ${lastAudioSampleRate}Hz, ${lastAudioChannels}CH</div>
      `;
    }, 1000);
    
    function addLogEntry(message, color = '#00ff00') {
      const timestamp = new Date().toLocaleTimeString().split(' ')[0]; // Remove AM/PM
      const entry = document.createElement('div');
      entry.style.color = color;
      entry.style.fontSize = '10px';
      entry.style.marginBottom = '2px';
      entry.innerHTML = `[${timestamp}] ${message}`;
      
      logContent.appendChild(entry);
      
      // Keep only last 15 entries for better performance
      while (logContent.children.length > 15) {
        logContent.removeChild(logContent.firstChild);
      }
      
      // Auto scroll to bottom
      logContent.scrollTop = logContent.scrollHeight;
    }
    
    // Listen for video frame data from main process
    ipcRenderer.on('screen-capture-video-frame', (event, frameData) => {
      totalVideoFrames++;
      videoFrameCounter++;
      
      const now = Date.now();
      const timeSinceLastFrame = lastFrameTime ? now - lastFrameTime : 0;
      lastFrameTime = now;
      
      lastVideoSize = `${frameData.width}x${frameData.height}`;
      
      // Log every 5th video frame to avoid spam
      if (totalVideoFrames % 5 === 0) {
        const logMessage = `📹 V-Frame #${frameData.frameNumber}: ${frameData.width}x${frameData.height}, Δ${timeSinceLastFrame}ms`;
        addLogEntry(logMessage, '#00ff00');
      }
      
      console.log('📹 Video frame received:', {
        frameNumber: frameData.frameNumber,
        width: frameData.width,
        height: frameData.height,
        timestamp: frameData.timestamp,
        timeSinceLastFrame: timeSinceLastFrame
      });
    });
    
    // Listen for audio frame data from main process
    ipcRenderer.on('screen-capture-audio-frame', (event, audioData) => {
      totalAudioFrames++;
      audioFrameCounter++;
      
      lastAudioChannels = audioData.channels || 0;
      lastAudioSampleRate = audioData.sampleRate || 0;
      
      // Log every 10th audio frame to avoid spam
      if (totalAudioFrames % 10 === 0) {
        const logMessage = `🔊 A-Frame #${audioData.frameNumber}: ${audioData.sampleRate}Hz, ${audioData.channels}CH`;
        addLogEntry(logMessage, '#ffaa00');
      }
      
      console.log('🔊 Audio frame received:', {
        frameNumber: audioData.frameNumber,
        sampleRate: audioData.sampleRate,
        channels: audioData.channels,
        timestamp: audioData.timestamp
      });
    });
    
    // Listen for capture events
    ipcRenderer.on('screen-capture-started', () => {
      addLogEntry('🟢 Screen capture started', '#00ff00');
      totalVideoFrames = 0;
      totalAudioFrames = 0;
      videoFrameCounter = 0;
      audioFrameCounter = 0;
    });
    
    ipcRenderer.on('screen-capture-stopped', () => {
      addLogEntry('🔴 Screen capture stopped', '#ff6666');
    });
    
    console.log('✅ Enhanced frame receiver setup complete');
  }

  // Set up frame receiver
  // setupFrameReceiver();




  // DEBUGGING: Add this temporary test in your main.ts window load handler:
  function createWebviewIntegrationTest() {
    console.log('🧪 Creating webview integration test...');
    
    const testButton = document.createElement('button');
    testButton.innerHTML = '🔍 Test Webview Native Capture';
    testButton.style.cssText = `
      position: fixed;
      top: 160px;
      right: 20px;
      z-index: 10000;
      padding: 12px 18px;
      background: #ff9800;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
    `;
    
    testButton.addEventListener('click', async () => {
      console.log('🧪 Testing webview integration...');
      testButton.innerHTML = '⏳ Testing...';
      
      try {
        // Send test message to webview
        ipcRenderer.send('forward-message', 'test-native-capture-in-webview');
        
        // Check if webview has native capture
        setTimeout(() => {
          testButton.innerHTML = '✅ Check Console';
          testButton.style.background = '#4caf50';
        }, 2000);
        
      } catch (error) {
        console.error('❌ Webview test error:', error);
        testButton.innerHTML = '❌ Error';
        testButton.style.background = '#f44336';
      }
      
      // Reset button
      setTimeout(() => {
        testButton.innerHTML = '🔍 Test Webview Native Capture';
        testButton.style.background = '#ff9800';
      }, 5000);
    });
    
    document.body.appendChild(testButton);
    console.log('✅ Webview integration test button added');
  }

  // Add this to your window.addEventListener("load", ...) function in main.ts
  // createWebviewIntegrationTest();

  function createTestButtons() {
    console.log('🧪 Creating test buttons for desktop sources...');
    
    // Кнопка для тестирования стандартного Electron
    const electronBtn = document.createElement('button');
    electronBtn.innerHTML = '🔬 Test Electron Sources';
    electronBtn.style.cssText = `
      position: fixed;
      top: 60px;
      right: 20px;
      z-index: 10000;
      padding: 12px 18px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 3px 6px rgba(0,0,0,0.2);
    `;
    
    electronBtn.onclick = async () => {
      console.log('🔬 Testing Electron desktopCapturer...');
      electronBtn.innerHTML = '⏳ Testing...';
      electronBtn.disabled = true;
      
      try {
        const result = await ipcRenderer.invoke('test-electron-sources');
        console.log('🔬 Test result:', result);
        
        if (result.success) {
          electronBtn.innerHTML = '✅ Electron Works!';
          electronBtn.style.background = '#4CAF50';
          alert(`✅ Electron desktopCapturer Works!\n\nFound ${result.sources.length} sources:\n${result.sources.slice(0, 3).map(s => `• ${s.name}`).join('\n')}`);
        } else {
          electronBtn.innerHTML = '❌ Electron Failed';
          electronBtn.style.background = '#f44336';
          alert(`❌ Electron failed: ${result.error}`);
        }
        
      } catch (error: any) {
        console.error('❌ Test error:', error);
        electronBtn.innerHTML = '❌ Error';
        electronBtn.style.background = '#f44336';
        alert(`❌ Error: ${error.message}`);
      }
      
      // Reset button
      setTimeout(() => {
        electronBtn.innerHTML = '🔬 Test Electron Sources';
        electronBtn.style.background = '#4CAF50';
        electronBtn.disabled = false;
      }, 5000);
    };
    
    document.body.appendChild(electronBtn);
    
    // Кнопка для получения RAW источников
    const rawBtn = document.createElement('button');
    rawBtn.innerHTML = '📋 Get Raw Sources';
    rawBtn.style.cssText = `
      position: fixed;
      top: 110px;
      right: 20px;
      z-index: 10000;
      padding: 12px 18px;
      background: #2196F3;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 3px 6px rgba(0,0,0,0.2);
    `;
    
    rawBtn.onclick = async () => {
      console.log('📋 Getting raw Electron sources...');
      rawBtn.innerHTML = '⏳ Loading...';
      rawBtn.disabled = true;
      
      try {
        const rawSources = await ipcRenderer.invoke('get-electron-sources-raw');
        console.log('📋 Raw sources:', rawSources);
        
        rawBtn.innerHTML = '✅ Got Raw!';
        rawBtn.style.background = '#4CAF50';
        
        // Показываем информацию о первых 3 источниках
        const info = rawSources.slice(0, 3).map((source: any, i: number) => 
          `${i + 1}. ${source.name}\n   ID: ${source.id}\n   Type: ${source.id.startsWith('screen:') ? 'Screen' : 'Window'}`
        ).join('\n\n');
        
        alert(`📋 Raw Electron Sources (${rawSources.length} total):\n\n${info}\n\nCheck console for full details.`);
        
      } catch (error: any) {
        console.error('❌ Raw sources error:', error);
        rawBtn.innerHTML = '❌ Error';
        rawBtn.style.background = '#f44336';
        alert(`❌ Error getting raw sources: ${error.message}`);
      }
      
      // Reset button
      setTimeout(() => {
        rawBtn.innerHTML = '📋 Get Raw Sources';
        rawBtn.style.background = '#2196F3';
        rawBtn.disabled = false;
      }, 5000);
    };
    
    document.body.appendChild(rawBtn);
    
    // Кнопка для тестирования обработчика get-desktop-sources
    const getSourcesBtn = document.createElement('button');
    getSourcesBtn.innerHTML = '🎯 Test get-desktop-sources';
    getSourcesBtn.style.cssText = `
      position: fixed;
      top: 160px;
      right: 20px;
      z-index: 10000;
      padding: 12px 18px;
      background: #FF9800;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 3px 6px rgba(0,0,0,0.2);
    `;
    
    getSourcesBtn.onclick = async () => {
      console.log('🎯 Testing get-desktop-sources handler...');
      getSourcesBtn.innerHTML = '⏳ Testing...';
      getSourcesBtn.disabled = true;
      
      try {
        const sources = await ipcRenderer.invoke('get-desktop-sources');
        console.log('🎯 get-desktop-sources result:', sources);
        
        getSourcesBtn.innerHTML = '✅ Handler Works!';
        getSourcesBtn.style.background = '#4CAF50';
        
        const info = `Found ${sources.length} formatted sources:\n\n` +
          sources.slice(0, 3).map((source: any, i: number) => 
            `${i + 1}. ${source.name}\n   ID: ${source.id}\n   Has thumbnail: ${source.thumbnail ? 'Yes' : 'No'}`
          ).join('\n\n');
        
        alert(`🎯 Desktop Sources Handler Result:\n\n${info}\n\nCheck console for full details.`);
        
      } catch (error: any) {
        console.error('❌ Handler test error:', error);
        getSourcesBtn.innerHTML = '❌ Handler Failed';
        getSourcesBtn.style.background = '#f44336';
        alert(`❌ Handler error: ${error.message}`);
      }
      
      // Reset button
      setTimeout(() => {
        getSourcesBtn.innerHTML = '🎯 Test get-desktop-sources';
        getSourcesBtn.style.background = '#FF9800';
        getSourcesBtn.disabled = false;
      }, 5000);
    };
    
    document.body.appendChild(getSourcesBtn);
    
    console.log('✅ Test buttons created');
  }

  // Добавить в конец window.addEventListener("load", ...) функции в main.ts:
  createTestButtons();

});