/* eslint-disable @typescript-eslint/no-unused-vars, unicorn/prefer-dom-node-text-content, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-floating-promises, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-array-delete, @typescript-eslint/naming-convention, @typescript-eslint/consistent-type-assertions */
import {clipboard} from "electron/common";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import {Menu, app, desktopCapturer, dialog, session} from "@electron/remote";
import * as remote from "@electron/remote";
import * as Sentry from "@sentry/electron/renderer";

import type {Config} from "../../common/config-util.js";
import * as ConfigUtil from "../../common/config-util.js";
import * as DNDUtil from "../../common/dnd-util.js";
import type {DndSettings} from "../../common/dnd-util.js";
import * as EnterpriseUtil from "../../common/enterprise-util.js";
import {html} from "../../common/html.js";
import * as LinkUtil from "../../common/link-util.js";
import Logger from "../../common/logger-util.js";
import * as Messages from "../../common/messages.js";
import {bundlePath, bundleUrl} from "../../common/paths.js";
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
import {AboutView} from "./pages/about.js";
import {PreferenceView} from "./pages/preference/preference.js";
import {initializeTray} from "./tray.js";
import {ipcRenderer} from "./typed-ipc-renderer.js";
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
  $updateProgress: HTMLElement;
  updateInfo: any = null;
  isUpdateReady = false;
  isDownloading = false;

  constructor() {
    this.$tabsContainer = document.querySelector("#tabs-container")!;

    const $actionsContainer = document.querySelector("#actions-container")!;
    this.$reloadButton = $actionsContainer.querySelector("#reload-action")!;
    this.$loadingIndicator =
      $actionsContainer.querySelector("#loading-action")!;
    this.$settingsButton = $actionsContainer.querySelector("#settings-action")!;
    this.$webviewsContainer = document.querySelector("#webviews-container")!;
    this.$backButton = $actionsContainer.querySelector("#back-action")!;
    this.$dndButton = $actionsContainer.querySelector("#dnd-action")!;

    // Инициализация кнопки обновления
    this.$updateButton = $actionsContainer.querySelector("#update-action")!;
    this.$updateTooltip = $actionsContainer.querySelector("#update-tooltip")!;
    this.$updateProgress = $actionsContainer.querySelector("#update-progress")!;

    this.$addServerTooltip = document.querySelector("#add-server-tooltip")!;
    this.$reloadTooltip = $actionsContainer.querySelector("#reload-tooltip")!;
    this.$loadingTooltip = $actionsContainer.querySelector("#loading-tooltip")!;
    this.$settingsTooltip =
      $actionsContainer.querySelector("#setting-tooltip")!;

    this.$serverIconTooltip = document.querySelectorAll(
      ".server-tooltip",
    ) as unknown as HTMLCollectionOf<HTMLElement>;
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const loadingIndicator = document.querySelector(
      "#loading-indicator",
    ) as HTMLElement | null;
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

    this.checkPendingUpdate();
  }

  checkPendingUpdate(): void {
    const pendingUpdate = ConfigUtil.getConfigItem("pendingUpdate", null);
    if (pendingUpdate) {
      this.updateInfo = pendingUpdate;
      this.showUpdateReady();
      // Автоматически показываем алерт при следующем заходе
      setTimeout(() => {
        this.showUpdateDialog();
      }, 2000);
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
        ? {mode: "system"}
        : ConfigUtil.getConfigItem("useManualProxy", false)
          ? {
              pacScript: ConfigUtil.getConfigItem("proxyPAC", ""),
              proxyRules: ConfigUtil.getConfigItem("proxyRules", ""),
              proxyBypassRules: ConfigUtil.getConfigItem("proxyBypass", ""),
            }
          : {mode: "direct"},
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
      {[Key in keyof Config]: [Key, Config[Key]]}[keyof Config]
    >) {
      if (EnterpriseUtil.configItemExists(setting)) {
        ConfigUtil.setConfigItem(
          setting,
          EnterpriseUtil.getConfigItem(setting, value),
          true,
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
        `Не удалось добавить ${domain}. Пожалуйста, свяжитесь с системным администратором.`,
      );
      return false;
    }
  }

  async initTabs(): Promise<void> {
    const server = {
      url: "http://localhost:9991/login/",
      alias: "Цифровые технологии РМ",
      icon: "https://disk.yandex.ru/i/m2aj56OOhsJfyw",
      zulipVersion: app.getVersion(),
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
        tab.setIcon(
          DomainUtil.iconAsUrl(
            "https://connectrm-svz.ru//user_avatars/2/realm/night_logo.png?version=2",
          ),
        );
      }
    }, 0);

    await this.activateTab(0);
  }

  initServer(server: ServerConfig, index: number): ServerTab {
    console.log("$webviewsContainer:", this.$webviewsContainer);
    console.log("server.url:", server.url);
    console.log(
      "preload:",
      url.pathToFileURL(path.join(bundlePath, "preload.js")).href,
    );

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
            this.loading.has((await tab.webview).properties.url),
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
    this.initUpdateButton();
  }

  // Main.ts - обновленный метод initUpdateButton
  initUpdateButton(): void {
    if (this.$updateButton) {
      // Изначально кнопка скрыта и неактивна
      this.$updateButton.classList.add("inactive", "hidden");

      // Добавляем элемент для прогресса
      this.$updateProgress = document.createElement("span");
      this.$updateProgress.id = "update-progress";
      this.$updateProgress.style.display = "none";
      this.$updateButton.append(this.$updateProgress);

      this.$updateButton.addEventListener("click", async () => {
        if (this.updateInfo && !this.isDownloading) {
          await this.startUpdateDownload();
        }
      });

      this.sidebarHoverEvent(this.$updateButton, this.$updateTooltip);
    }
  }

  async startUpdateDownload(): Promise<void> {
    if (!this.updateInfo || this.isDownloading) return;

    this.isDownloading = true;
    this.$updateButton.classList.remove("inactive");
    this.$updateButton.classList.add("downloading");
    this.$updateProgress.style.display = "block";
    this.$updateProgress.textContent = "0%";

    // Используем существующий обработчик
    const result = await ipcRenderer.invoke("handle-zulip-update", {
      version: this.updateInfo.version,
      downloadUrl: this.updateInfo.download_url,
      releaseNotes: this.updateInfo.release_notes,
    });

    if (result.success) {
      if (result.action === "updated") {
        // Обновление установлено, приложение перезапустится
        this.resetUpdateButton();
      } else if (result.action === "postponed") {
        // Пользователь отложил, кнопка становится яркой
        this.showUpdateReady();
        // Сохраняем для повторного показа
        ConfigUtil.setConfigItem("postponedUpdate", this.updateInfo);
      }
    } else {
      this.showUpdateError(
        (result as {success: boolean; error?: string}).error || "Unknown error",
      );
    }

    this.isDownloading = false;
  }

  async checkForUpdates(): Promise<void> {
    try {
      // Здесь должна быть проверка обновлений с сервера
      const response = await fetch(
        "https://your-update-server.com/check-version",
      );
      const data = await response.json();

      const currentVersion = app.getVersion();
      if (this.isNewerVersion(data.version, currentVersion)) {
        this.updateInfo = data;
        this.showUpdateAvailable(data);
      }
    } catch (error) {
      console.error("Ошибка проверки обновлений:", error);
    }
  }

  isNewerVersion(newVersion: string, currentVersion: string): boolean {
    const newParts = newVersion.split(".").map(Number);
    const currentParts = currentVersion.split(".").map(Number);

    for (let i = 0; i < Math.max(newParts.length, currentParts.length); i++) {
      const newPart = newParts[i] || 0;
      const currentPart = currentParts[i] || 0;
      if (newPart > currentPart) return true;
      if (newPart < currentPart) return false;
    }

    return false;
  }

  showUpdateAvailable(info: any): void {
    this.updateInfo = info;
    this.$updateButton.classList.remove("hidden", "inactive");
    this.$updateButton.classList.add("available");
    this.$updateTooltip.innerText = `Доступна версия ${info.version}`;
  }

  resetUpdateButton(): void {
    this.$updateButton.classList.add("hidden");
    this.$updateButton.classList.remove(
      "available",
      "downloading",
      "ready",
      "error",
    );
    this.$updateProgress.style.display = "none";
    this.updateInfo = null;
    this.isUpdateReady = false;
    ConfigUtil.removeConfigItem("postponedUpdate");
  }

  async downloadUpdate(): Promise<void> {
    this.$updateButton.classList.remove("available");
    this.$updateButton.classList.add("downloading");
    this.$updateProgress.style.display = "block";

    try {
      const result = await ipcRenderer.invoke(
        "download-update",
        this.updateInfo,
      );

      if (result.success) {
        this.showUpdateReady();
        // Сохраняем информацию об обновлении
        ConfigUtil.setConfigItem("pendingUpdate", this.updateInfo);
      } else {
        this.showUpdateError(
          (result as {success: boolean; error?: string}).error ||
            "Unknown error",
        );
      }
    } catch (error: unknown) {
      this.showUpdateError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  showUpdateReady(): void {
    this.isUpdateReady = true;
    this.$updateButton.classList.remove("downloading", "inactive");
    this.$updateButton.classList.add("ready");
    this.$updateProgress.style.display = "none";
    this.$updateTooltip.innerText = "Готово к установке! Нажмите для установки";
  }

  showUpdateError(error: string): void {
    this.$updateButton.classList.remove("downloading");
    this.$updateButton.classList.add("error");
    this.$updateProgress.style.display = "none";
    this.$updateTooltip.innerText = `Ошибка: ${error}`;
  }

  async showUpdateDialog(): Promise<void> {
    const choice = await dialog.showMessageBox({
      type: "info",
      title: "Обновление готово",
      message: `Версия ${this.updateInfo.version} готова к установке`,
      detail:
        this.updateInfo.releaseNotes ||
        "Рекомендуется установить обновление для получения новых функций и исправлений.",
      buttons: ["Установить сейчас", "Позже"],
      defaultId: 0,
      cancelId: 1,
    });

    if (choice.response === 0) {
      // Устанавливаем обновление
      await this.installUpdate();
    }
  }

  async installUpdate(): Promise<void> {
    // Удаляем сохраненную информацию об обновлении
    ConfigUtil.removeConfigItem("pendingUpdate");

    // Запускаем установку
    ipcRenderer.send("install-update");
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
      this.toggleDndButton(dndUtil.dnd);
      ipcRenderer.send(
        "forward-message",
        "toggle-dnd",
        dndUtil.dnd,
        dndUtil.newSettings,
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
    // This.sidebarHoverEvent(this.$updateButton, this.$updateTooltip);
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
      `webview[data-tab-id="${CSS.escape(webviewId)}"]`,
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
    addServer = false,
  ): void {
    SidebarButton.addEventListener("mouseover", () => {
      SidebarTooltip.removeAttribute("style");
      if (addServer) {
        const {top} = SidebarButton.getBoundingClientRect();
        SidebarTooltip.style.top = `${top}px`;
      }
    });
    SidebarButton.addEventListener("mouseout", () => {
      SidebarTooltip.style.display = "none";
    });
  }

  onHover(index: number): void {
    this.$serverIconTooltip[index].removeAttribute("style");
    const {top} =
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
      }),
    );

    this.$webviewsContainer.classList.remove("loaded");
    await this.activateTab(this.functionalTabs.get(tabProperties.page)!);
  }

  async openSettings(
    navigationItem: NavigationItem = "General",
  ): Promise<void> {
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
        this.loading.has((await tab.webview).properties.url),
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
      }),
    );
    ipcRenderer.send("update-badge", messageCountAll);
  }

  toggleSidebar(show: boolean): void {
    this.$sidebar.classList.toggle("sidebar-hide", !show);
  }

  toggleDndButton(alert: boolean): void {
    this.$dndTooltip.textContent = alert ? "Включить" : "Отключить";
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
      contextMenu.popup({window: remote.getCurrentWindow()});
    });
  }

  registerIpcs(): void {
    const webviewListeners: Array<
      [WebviewListener, (webview: WebView) => void]
    > = [
      [
        "webview-reload",
        (webview) => {
          webview.reload();
        },
      ],
      [
        "back",
        (webview) => {
          webview.back();
        },
      ],
      [
        "focus",
        (webview) => {
          webview.focus();
        },
      ],
      [
        "forward",
        (webview) => {
          webview.forward();
        },
      ],
      [
        "zoomIn",
        (webview) => {
          webview.zoomIn();
        },
      ],
      [
        "zoomOut",
        (webview) => {
          webview.zoomOut();
        },
      ],
      [
        "zoomActualSize",
        (webview) => {
          webview.zoomActualSize();
        },
      ],
      [
        "log-out",
        (webview) => {
          webview.logOut();
        },
      ],
      [
        "show-keyboard-shortcuts",
        (webview) => {
          webview.showKeyboardShortcuts();
        },
      ],
      [
        "tab-devtools",
        (webview) => {
          webview.openDevTools();
        },
      ],
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
      console.log(
        "Renderer: Получено событие quit-app, перенаправление в основной процесс",
      );
      ipcRenderer.send("quit-app");
    });

    ipcRenderer.on(
      "permission-request",
      async (
        event,
        {
          webContentsId,
          origin,
          permission,
        }: {webContentsId: number | null; origin: string; permission: string},
        permissionCallbackId: number,
      ) => {
        ipcRenderer.send("permission-callback", permissionCallbackId, true);
      },
    );

    ipcRenderer.on("open-settings", async () => {
      await this.openSettings();
    });

    ipcRenderer.on("open-about", this.openAbout.bind(this));

    ipcRenderer.on("reload-viewer", this.reloadView.bind(this));

    ipcRenderer.on("reload-current-viewer", this.reloadCurrentView.bind(this));

    ipcRenderer.on("hard-reload", () => {
      ipcRenderer.send("reload-full-app");
    });

    ipcRenderer.on("switch-server-tab", async (event, index: number) => {
      await this.activateLastTab(index);
    });

    ipcRenderer.on("reload-proxy", async (event, showAlert: boolean) => {
      await this.loadProxy();
      if (showAlert) {
        await dialog.showMessageBox({
          message: t.__("Настройки прокси сохранены."),
          buttons: [t.__("OK")],
        });
        ipcRenderer.send("reload-full-app");
      }
    });

    ipcRenderer.on("toggle-sidebar", async (event, show: boolean) => {
      this.toggleSidebar(show);
    });

    ipcRenderer.on("toggle-silent", async (event, state: boolean) => {
      // Звук от приложения всегда должен поступать
      // Не выключаем звук для вкладок основного окна
      // Этот обработчик оставлен для совместимости, но не влияет на звук
      logger.log(
        `[MAIN] toggle-silent received but ignored - sound always enabled for main window`,
      );
    });

    ipcRenderer.on(
      "toggle-autohide-menubar",
      async (event, autoHideMenubar: boolean, updateMenu: boolean) => {
        if (updateMenu) {
          ipcRenderer.send("update-menu", {
            tabs: this.tabsForIpc,
            activeTabIndex: this.activeTabIndex,
          });
        }
      },
    );

    ipcRenderer.on(
      "toggle-dnd",
      async (event, state: boolean, newSettings: Partial<DndSettings>) => {
        // Кнопка DND скрыта, этот обработчик оставлен для совместимости
        // Не влияем на звук основного приложения
        logger.log(
          `[MAIN] toggle-dnd received but ignored - DND button is hidden`,
        );
      },
    );

    ipcRenderer.on(
      "update-realm-name",
      (event, serverURL: string, realmName: string) => {
        for (const [index, domain] of DomainUtil.getDomains().entries()) {
          if (domain.url === serverURL) {
            const tab = this.tabs[index];
            if (tab instanceof ServerTab) tab.setLabel(realmName);
            domain.alias = realmName;
            DomainUtil.updateDomain(index, domain);
            ipcRenderer.send("update-menu", {
              tabs: this.tabsForIpc,
              activeTabIndex: this.activeTabIndex,
            });
          }
        }
      },
    );

    ipcRenderer.on(
      "update-realm-icon",
      async (event, serverURL: string, iconURL: string) => {
        await Promise.all(
          DomainUtil.getDomains().map(async (domain, index) => {
            if (domain.url === serverURL) {
              const localIconPath = await DomainUtil.saveServerIcon(iconURL);
              const tab = this.tabs[index];
              if (tab instanceof ServerTab)
                tab.setIcon(DomainUtil.iconAsUrl(localIconPath));
              domain.icon = localIconPath;
              DomainUtil.updateDomain(index, domain);
            }
          }),
        );
      },
    );

    ipcRenderer.on("enter-fullscreen", () => {
      this.$fullscreenPopup.classList.add("show");
      this.$fullscreenPopup.classList.remove("hidden");
    });

    ipcRenderer.on("leave-fullscreen", () => {
      this.$fullscreenPopup.classList.remove("show");
    });

    ipcRenderer.on("focus-webview-with-id", async (event, webviewId: number) =>
      Promise.all(
        this.tabs.map(async (tab) => {
          if (
            tab instanceof ServerTab &&
            (await tab.webview).webContentsId === webviewId
          ) {
            const concurrentTab: HTMLButtonElement = document.querySelector(
              `div[data-tab-id="${CSS.escape(`${tab.properties.tabIndex}`)}"]`,
            )!;
            concurrentTab.click();
          }
        }),
      ),
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

      ipcRenderer.send(
        "update-taskbar-icon",
        createOverlayIcon(messageCount).toDataURL(),
        String(messageCount),
      );
    });

    ipcRenderer.on("copy-rm-url", async () => {
      clipboard.writeText(await this.getCurrentActiveServer());
    });

    ipcRenderer.on("set-active", async () =>
      Promise.all(
        this.tabs.map(async (tab) => {
          if (tab instanceof ServerTab) (await tab.webview).send("set-active");
        }),
      ),
    );

    ipcRenderer.on("set-idle", async () =>
      Promise.all(
        this.tabs.map(async (tab) => {
          if (tab instanceof ServerTab) (await tab.webview).send("set-idle");
        }),
      ),
    );

    ipcRenderer.on("open-network-settings", async () => {
      await this.openSettings("Network");
    });

    ipcRenderer.on("play-ding-sound", async () => {
      await dingSound.play();
    });

    ipcRenderer.on("server-update-available", (event, updateInfo) => {
      this.showUpdateAvailable(updateInfo);
    });

    ipcRenderer.on("update_available", (event, version: string) => {
      this.$updateTooltip.innerText = `Доступно: v${version}`;
      this.$updateButton.classList.remove("hidden");
    });

    ipcRenderer.on("force-update", (event) => {
      console.log("Renderer: Получено событие на обновление");
      this.$updateButton.click();
    });

    ipcRenderer.on("update_progress", (event, percent: number) => {
      this.$updateTooltip.innerText = `Загрузка: ${Math.trunc(percent)}%`;
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

    ipcRenderer.on("update-available", (event, info) => {
      this.updateInfo = info;
      this.showUpdateAvailable(info);
    });

    ipcRenderer.on("update-download-progress", (event, progress) => {
      if (this.$updateProgress && this.isDownloading) {
        this.$updateProgress.textContent = `${Math.round(progress)}%`;
      }
    });

    ipcRenderer.on("update-downloaded", () => {
      this.showUpdateReady();
      ConfigUtil.setConfigItem("pendingUpdate", this.updateInfo);

      // Показываем диалог сразу после загрузки
      setTimeout(() => {
        this.showUpdateDialog();
      }, 1000);
    });

    ipcRenderer.on("update-error", (event, error) => {
      this.showUpdateError(error);
    });

    const postponedUpdate = ConfigUtil.getConfigItem("postponedUpdate", null);

    if (postponedUpdate) {
      this.updateInfo = postponedUpdate;
      this.showUpdateReady();

      // Автоматически показываем диалог через 3 секунды
      setTimeout(() => {
        this.startUpdateDownload();
      }, 3000);
    }
  }
}

// Replace your entire window.addEventListener("load", ...) section with this clean version
// This removes all the problematic window checks and focuses on the working remote API

window.addEventListener("load", async () => {
  const appVersion = app.getVersion();
  const isWin = process.platform === "win32";

  document.body.innerHTML = html`
    <style>
      .version-label {
        color: white;
        opacity: 0.25;
        margin-left: 7px;
      }

      /* Стили для кнопки обновления */
      #update-action {
        position: relative;
        overflow: hidden;
      }

      #update-progress-bar {
        position: absolute;
        bottom: 0;
        left: 0;
        height: 3px;
        background: linear-gradient(90deg, #4caf50, #8bc34a);
        transition: width 0.3s ease;
        width: 0%;
      }

      #update-progress-text {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 14px;
        font-weight: bold;
        color: white;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        z-index: 10;
      }

      #update-action.downloading i {
        opacity: 0.1;
        animation: pulse 1s infinite;
      }

      #update-tooltip,
      #reload-tooltip,
      #loading-tooltip,
      #setting-tooltip,
      #back-tooltip,
      #dnd-tooltip {
        color: white !important;
        background: rgba(0, 0, 0, 0.9);
        padding: 5px 10px;
        border-radius: 4px;
        font-size: 12px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 1000;
      }

      /* Для темной темы */
      body.dark-theme #update-tooltip,
      body.dark-theme [id$="-tooltip"] {
        color: white !important;
        background: rgba(0, 0, 0, 0.9);
      }

      /* Прогресс текст всегда белый */
      #update-progress-text {
        color: white !important;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 0.1;
        }
        50% {
          opacity: 0.3;
        }
      }
      /* Кастомный title bar */
      #custom-titlebar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 32px;
        background: rgb(34 44 49);
        -webkit-app-region: drag;
        z-index: 100;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #custom-titlebar .titlebar-title {
        color: rgba(255, 255, 255, 0.6);
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-weight: 500;
        letter-spacing: 0.3px;
        user-select: none;
      }

      /* Кнопки управления окном для Windows */
      .titlebar-controls {
        position: absolute;
        right: 0;
        top: 0;
        height: 100%;
        display: flex;
        -webkit-app-region: no-drag;
      }

      .titlebar-button {
        width: 46px;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: rgba(255, 255, 255, 0.7);
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .titlebar-button:hover {
        background: rgba(255, 255, 255, 0.1);
      }

      .titlebar-button.close:hover {
        background: #e81123;
        color: white;
      }

      .titlebar-button svg {
        width: 10px;
        height: 10px;
      }

      /* На macOS traffic lights находятся слева */
      ${process.platform === "darwin"
        ? html` #custom-titlebar { padding-left: 70px; } `
        : html`
            #custom-titlebar { height: 32px; } .titlebar-button { width: 46px;
            height: 32px; }
          `}
    </style>
    <div id="custom-titlebar">
      <span class="titlebar-title"></span>
      ${process.platform === "win32"
        ? html`
            <div class="titlebar-controls">
              <button class="titlebar-button minimize" id="titlebar-minimize">
                <svg viewBox="0 0 10 1">
                  <path fill="currentColor" d="M0 0h10v1H0z" />
                </svg>
              </button>
              <button class="titlebar-button maximize" id="titlebar-maximize">
                <svg viewBox="0 0 10 10">
                  <path fill="currentColor" d="M0 0v10h10V0H0zm1 1h8v8H1V1z" />
                </svg>
              </button>
              <button class="titlebar-button close" id="titlebar-close">
                <svg viewBox="0 0 10 10">
                  <path
                    fill="currentColor"
                    d="M1.41 0L5 3.59 8.59 0 10 1.41 6.41 5 10 8.59 8.59 10 5 6.41 1.41 10 0 8.59 3.59 5 0 1.41z"
                  />
                </svg>
              </button>
            </div>
          `
        : html``}
    </div>
    <div id="content">
      <div class="popup">
        <span class="popuptext hidden" id="fullscreen-popup"></span>
      </div>
      <div id="sidebar" class="toggle-sidebar">
        <div id="view-controls-container">
          <div id="tabs-container"></div>
        </div>
        <div id="actions-container">
          <div
            class="action-button hidden"
            id="dnd-action"
            style="display: none;"
          >
            <i class="material-icons md-48">notifications</i>
            <span id="dnd-tooltip" style="display: none"
              >${t.__("Не беспокоить")}</span
            >
          </div>
          <div class="action-button hidden" id="reload-action">
            <i class="material-icons md-48">refresh</i>
            <span id="reload-tooltip" style="display: none"
              >${t.__("Обновить")}</span
            >
          </div>
          <div class="action-button disable" id="loading-action">
            <i class="refresh material-icons md-48">loop</i>
            <span id="loading-tooltip" style="display: none"
              >${t.__("Загрузка")}</span
            >
          </div>
          <div class="action-button disable" id="back-action">
            <i class="material-icons md-48">arrow_back</i>
            <span id="back-tooltip" style="display: none"
              >${t.__("Назад")}</span
            >
          </div>
          <div class="action-button" id="settings-action">
            <i class="material-icons md-48">settings</i>
            <span id="setting-tooltip" style="display: none"
              >${t.__("Настройки")}</span
            >
          </div>
          <div class="action-button" id="update-action">
            <i class="material-icons md-48">system_update_alt</i>
          </div>
          <div class="version-label">${appVersion}</div>
        </div>
      </div>
      <div id="main-container">
        <div id="webviews-container"></div>
      </div>
    </div>
  `.html;

  // Обработчики для кнопок управления окном на Windows
  if (process.platform === "win32") {
    const currentWindow = remote.getCurrentWindow();

    document
      .querySelector("#titlebar-minimize")
      ?.addEventListener("click", () => {
        currentWindow.minimize();
      });

    document
      .querySelector("#titlebar-maximize")
      ?.addEventListener("click", () => {
        if (currentWindow.isMaximized()) {
          currentWindow.unmaximize();
        } else {
          currentWindow.maximize();
        }
      });

    document.querySelector("#titlebar-close")?.addEventListener("click", () => {
      currentWindow.close();
    });
  }

  const serverManagerView = new ServerManagerView();
  await serverManagerView.init();
});
