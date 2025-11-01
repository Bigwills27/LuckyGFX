"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const body = document.body;
  const nav = document.querySelector(".site-nav");
  const sidebar = document.querySelector(".site-header");
  const sidebarCollapse = document.querySelector("[data-sidebar-collapse]");
  const sidebarOpenButtons = document.querySelectorAll("[data-sidebar-open]");
  const darkToggle = document.querySelector("[data-dark-toggle]");
  const logoutLink = document.querySelector(".logout-link");
  const spinnerOverlay = document.querySelector("[data-spinner-overlay]");
  const toastStack = document.querySelector("[data-toast-stack]");
  const ohlcSection = document.querySelector("[data-ohlc-section]");
  const ohlcStatus = document.querySelector("[data-ohlc-status]");
  const ohlcPre = document.querySelector("[data-ohlc-pre]");
  const ohlcRefreshButton = document.querySelector("[data-refresh-ohlc]");
  const mobileQuery = window.matchMedia("(max-width: 900px)");
  const COLLAPSE_KEY = "ahmed-agent-sidebar-collapsed";
  const TOAST_TIMEOUT = 4800;
  const AUTH_STORAGE_KEY = "ahmed-agent-auth-token";
  const AUTH_USERNAME_KEY = "ahmed-agent-auth-username";
  const pageId = body.dataset.page || "";
  const isLoginPage = pageId === "login";
  const isChartPage = pageId === "chart";
  const chartState = {
    symbol: "",
    label: "",
    interval: "60",
    hours: 24,
  };
  let chartSwitcher = null;
  let tradingViewLoaderPromise = null;
  const apiBaseUrl = resolveApiBase();
  const apiRoot = resolveApiRoot();
  let authState = getStoredAuthState();
  let unauthorizedRedirectPending = false;

  if (isLoginPage && authState) {
    redirectToDashboard();
    return;
  }

  if (!isLoginPage && !authState) {
    redirectToLogin();
    return;
  }

  // Initialise icons
  if (window.feather) {
    window.feather.replace();
  }

  // Restore theme preference
  const storedTheme = localStorage.getItem("ahmed-agent-theme");
  if (storedTheme === "dark" || storedTheme === "light") {
    body.dataset.theme = storedTheme;
  }

  if (darkToggle) {
    darkToggle.addEventListener("click", () => {
      const nextTheme = body.dataset.theme === "dark" ? "light" : "dark";
      body.dataset.theme = nextTheme;
      localStorage.setItem("ahmed-agent-theme", nextTheme);
      showToast(`Switched to ${nextTheme === "dark" ? "dark" : "light"} mode`);
      if (window.feather) {
        window.feather.replace();
      }
      if (isChartPage) {
        refreshChart();
      }
    });
  }

  if (sidebar) {
    initializeSidebar();
  }

  // Highlight current navigation item
  const currentPage = pageId;
  if (currentPage && nav) {
    const activeLink = nav.querySelector(`[data-page-link="${currentPage}"]`);
    if (activeLink) {
      activeLink.classList.add("active");
    }
  }

  initializeChartCards();

  if (logoutLink) {
    logoutLink.addEventListener("click", () => {
      clearStoredAuthState();
      unauthorizedRedirectPending = false;
    });
  }

  if (ohlcRefreshButton) {
    ohlcRefreshButton.addEventListener("click", () => {
      fetchOHLCData({
        symbol: chartState.symbol || "XAUUSD",
        timeframe: chartState.interval,
        forceRefresh: true,
      });
    });
  }

  if (isChartPage) {
    initializeChartPage();
  }

  function initializeSidebar() {
    if (!sidebar) return;

    if (!mobileQuery.matches) {
      const storedCollapsed = localStorage.getItem(COLLAPSE_KEY) === "true";
      if (storedCollapsed) {
        body.classList.add("sidebar-collapsed");
      }
    }

    updateCollapseAria();

    if (sidebarCollapse) {
      sidebarCollapse.addEventListener("click", () => {
        if (mobileQuery.matches) {
          body.classList.remove("sidebar-open");
          return;
        }
        const nextCollapsed = !body.classList.contains("sidebar-collapsed");
        setCollapsed(nextCollapsed);
        updateCollapseAria();
      });
    }

    sidebarOpenButtons.forEach((button) => {
      button.addEventListener("click", () => {
        if (mobileQuery.matches) {
          body.classList.toggle("sidebar-open");
        } else {
          const nextCollapsed = !body.classList.contains("sidebar-collapsed");
          setCollapsed(nextCollapsed);
          updateCollapseAria();
        }
      });
    });

    document.addEventListener("click", (event) => {
      if (!mobileQuery.matches || !body.classList.contains("sidebar-open")) {
        return;
      }
      const target = event.target;
      if (
        (sidebar && sidebar.contains(target)) ||
        target.closest("[data-sidebar-open]")
      ) {
        return;
      }
      body.classList.remove("sidebar-open");
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        body.classList.remove("sidebar-open");
      }
    });

    if (nav) {
      nav.addEventListener("click", (event) => {
        if (mobileQuery.matches && event.target.closest("a")) {
          body.classList.remove("sidebar-open");
        }
      });
    }

    handleViewportChange(mobileQuery);
    if (typeof mobileQuery.addEventListener === "function") {
      mobileQuery.addEventListener("change", handleViewportChange);
    } else if (typeof mobileQuery.addListener === "function") {
      mobileQuery.addListener(handleViewportChange);
    }
  }

  function setCollapsed(collapsed) {
    if (collapsed) {
      body.classList.add("sidebar-collapsed");
    } else {
      body.classList.remove("sidebar-collapsed");
    }
    if (!mobileQuery.matches) {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "true" : "false");
    }
  }

  function handleViewportChange(event) {
    if (!sidebar) return;
    const isMobile = event.matches;
    if (isMobile) {
      body.classList.remove("sidebar-collapsed");
      body.classList.remove("sidebar-open");
    } else {
      const storedCollapsed = localStorage.getItem(COLLAPSE_KEY) === "true";
      setCollapsed(storedCollapsed);
      body.classList.remove("sidebar-open");
    }
    updateCollapseAria();
  }

  function updateCollapseAria() {
    if (!sidebarCollapse) return;
    const expanded = !body.classList.contains("sidebar-collapsed");
    sidebarCollapse.setAttribute("aria-expanded", expanded.toString());
  }

  // Placeholder interactions
  document.querySelectorAll("[data-placeholder]").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.preventDefault();
      const message =
        el.dataset.placeholder || "This feature is not available yet.";
      showToast(message);
    });
  });

  // Login form mock submission spinner
  const authForm = document.querySelector("[data-auth-form]");
  if (authForm) {
    initializeLoginForm(authForm);
  }

  // Export button placeholder
  const exportBtn = document.querySelector("[data-export]");
  if (exportBtn) {
    exportBtn.addEventListener("click", (event) => {
      event.preventDefault();
      showToast("CSV export will be added after the backend is connected.");
    });
  }

  function initializeChartCards() {
    const cards = document.querySelectorAll(
      "[data-chart-symbol][data-chart-label]"
    );
    if (!cards.length) {
      return;
    }
    cards.forEach((card) => {
      card.addEventListener("click", () => {
        redirectToChart(card);
      });
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          redirectToChart(card);
        }
      });
    });
  }

  function redirectToChart(card) {
    const symbol = card.dataset.chartSymbol;
    if (!symbol) {
      return;
    }
    const label = card.dataset.chartLabel || symbol;
    const interval = card.dataset.chartInterval || "60";
    const hours = card.dataset.chartHours || "24";
    const params = new URLSearchParams({
      symbol,
      label,
      interval,
      hours,
    });
    window.location.href = `/chart?${params.toString()}`;
  }

  function initializeChartPage() {
    const params = new URLSearchParams(window.location.search);
    const symbol = params.get("symbol") || "XAUUSD";
    const label = params.get("label") || symbol;
    const interval = params.get("interval") || "60";
    const hoursParam = Number.parseInt(params.get("hours") || "", 10);
    const hours =
      Number.isFinite(hoursParam) && hoursParam > 0 ? hoursParam : 24;

    chartState.symbol = symbol;
    chartState.label = label;
    chartState.interval = interval;
    chartState.hours = hours;

    setupChartSwitcher();
    applyChartSelection(symbol, label, interval, { updateURL: false });
  }

  function initializeLoginForm(form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const username = (formData.get("username") || "").trim();
      const password = formData.get("password") || "";

      if (!username || !password) {
        showToast("Please enter both username and password.");
        return;
      }

      toggleSpinner(true);

      try {
        const encoded = encodeBasicCredentials(username, password);
        const response = await fetch(buildApiUrl("login"), {
          method: "POST",
          headers: {
            Authorization: `Basic ${encoded}`,
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error("Invalid username or password.");
          }
          throw new Error(`Login failed (${response.status}).`);
        }

        await response.json().catch(() => ({}));
        authState = persistAuthCredentials(username, password);
        unauthorizedRedirectPending = false;
        showToast(`Welcome back, ${username}!`);
        setTimeout(() => {
          redirectToDashboard();
        }, 500);
      } catch (error) {
        showToast(error.message || "Login failed. Please try again.");
      } finally {
        toggleSpinner(false);
      }
    });
  }

  function resolveApiBase() {
    const datasetValue = body.dataset.apiBase;
    if (typeof datasetValue === "string" && datasetValue.trim()) {
      return datasetValue.trim().replace(/\/$/, "");
    }

    if (typeof window !== "undefined") {
      const globalValue = window.__AHMED_AGENT_API_BASE__;
      if (typeof globalValue === "string" && globalValue.trim()) {
        return globalValue.trim().replace(/\/$/, "");
      }

      if (
        window.location &&
        window.location.origin &&
        window.location.origin !== "null"
      ) {
        return window.location.origin.replace(/\/$/, "");
      }
    }

    return "http://localhost:3000";
  }

  function resolveApiRoot() {
    const cleaned = apiBaseUrl.replace(/\/$/, "");
    return cleaned.endsWith("/api") ? cleaned : `${cleaned}/api`;
  }

  function buildApiUrl(path) {
    const normalized = typeof path === "string" ? path.replace(/^\/+/, "") : "";
    return new URL(normalized, `${apiRoot}/`).toString();
  }

  function fetchOHLCData({
    symbol,
    timeframe,
    count,
    sma,
    guest,
    forceRefresh,
  } = {}) {
    if (!isChartPage || !ohlcPre) {
      return Promise.resolve(null);
    }

    const targetSymbol = (symbol || chartState.symbol || "XAUUSD")
      .trim()
      .toUpperCase();
    const targetTimeframe = (timeframe || chartState.interval || "60").trim();
    const recentCount =
      Number.isFinite(count) && count > 0 ? Math.min(count, 50) : 10;
    const smaPeriod = Number.isFinite(sma) && sma > 0 ? sma : 9;

    if (ohlcStatus) {
      const isInitialLoad = !(ohlcSection && ohlcSection.dataset.lastLoaded);
      ohlcStatus.textContent = isInitialLoad
        ? "Loading OHLC data…"
        : "Refreshing OHLC data…";
    }

    const params = new URLSearchParams({
      symbol: targetSymbol,
      timeframe: targetTimeframe,
      count: String(recentCount),
      sma: String(smaPeriod),
    });

    if (guest) {
      params.set("guest", "1");
    }

    if (forceRefresh) {
      params.set("_", Date.now().toString());
    }

    const endpointUrl = new URL("tradingview/candles", `${apiRoot}/`);
    endpointUrl.search = params.toString();

    const headers = {
      Accept: "application/json",
    };

    const authHeader = getAuthorizationHeader();
    if (!authHeader) {
      handleUnauthorized();
      return Promise.resolve(null);
    }

    headers.Authorization = authHeader;

    return fetch(endpointUrl.toString(), { headers })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 401) {
            const unauthorizedError = new Error("Unauthorized");
            unauthorizedError.status = 401;
            throw unauthorizedError;
          }
          let errorDetail = `Request failed with status ${response.status}`;
          try {
            const errorBody = await response.clone().json();
            if (errorBody && errorBody.error) {
              errorDetail = errorBody.error;
            }
          } catch (parseError) {
            try {
              const textBody = await response.text();
              if (textBody) {
                errorDetail = textBody;
              }
            } catch (_) {
              // ignore parsing errors
            }
          }
          const error = new Error(errorDetail);
          error.status = response.status;
          throw error;
        }
        return response.json();
      })
      .then((payload) => {
        if (!payload.success || !payload.data) {
          throw new Error(payload.error || "No OHLC data returned");
        }

        const pretty = JSON.stringify(payload.data, null, 2);
        if (ohlcPre) {
          ohlcPre.textContent = pretty;
        }

        if (ohlcStatus) {
          const formingCandle =
            payload.data.candles?.find((item) => item.forming) || null;
          const lastCompleted =
            payload.data.candles && payload.data.candles.length > 1
              ? payload.data.candles[payload.data.candles.length - 2]
              : null;
          const formingTime = formingCandle?.timestamp
            ? new Date(formingCandle.timestamp).toLocaleString()
            : null;
          const lastCompletedTime = lastCompleted?.timestamp
            ? new Date(lastCompleted.timestamp).toLocaleString()
            : null;
          let updatedText = "Data loaded.";
          if (formingTime) {
            updatedText = `Forming candle: ${formingTime}`;
          }
          if (lastCompletedTime) {
            updatedText += ` (last close: ${lastCompletedTime})`;
          }
          ohlcStatus.textContent = updatedText;
        }

        if (ohlcSection) {
          ohlcSection.dataset.lastLoaded = new Date().toISOString();
        }

        return payload.data;
      })
      .catch((error) => {
        console.error("Unable to fetch OHLC data", error);
        if (ohlcStatus) {
          const message =
            error.message && error.message.trim().length
              ? error.message
              : "Unable to load OHLC data. Please try again.";
          ohlcStatus.textContent = message;
        }
        if (ohlcPre) {
          ohlcPre.textContent = error.message || "Unexpected error";
        }
        if (error.status === 401) {
          handleUnauthorized();
        } else {
          showToast("Unable to fetch OHLC data. Please try again soon.");
        }
        return null;
      });
  }

  function refreshChart() {
    if (!isChartPage || !chartState.symbol) {
      return;
    }
    renderTradingViewChart(chartState.symbol, chartState.interval).catch(
      (error) => {
        console.error(error);
      }
    );
  }

  function setupChartSwitcher() {
    chartSwitcher = document.querySelector("[data-chart-switcher]");
    if (!chartSwitcher) {
      return;
    }

    const toggle = chartSwitcher.querySelector("[data-chart-switcher-toggle]");
    const menu = chartSwitcher.querySelector("[data-chart-switcher-menu]");
    const labelEl = chartSwitcher.querySelector("[data-chart-switcher-label]");
    const options = chartSwitcher.querySelectorAll("[data-chart-option]");

    if (!toggle || !menu || !labelEl || !options.length) {
      return;
    }

    const closeMenu = () => {
      chartSwitcher.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      menu.hidden = true;
    };

    const openMenu = () => {
      chartSwitcher.classList.add("is-open");
      toggle.setAttribute("aria-expanded", "true");
      menu.hidden = false;
    };

    const toggleMenu = () => {
      if (chartSwitcher.classList.contains("is-open")) {
        closeMenu();
      } else {
        openMenu();
        const active = chartSwitcher.querySelector(
          "[data-chart-option].is-active"
        );
        active?.focus();
      }
    };

    toggle.addEventListener("click", () => {
      toggleMenu();
    });

    toggle.addEventListener("keydown", (event) => {
      if (
        event.key === "ArrowDown" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openMenu();
        const firstOption = options[0];
        firstOption?.focus();
      }
    });

    options.forEach((option) => {
      option.addEventListener("click", () => {
        const { symbol, label, interval } = option.dataset;
        applyChartSelection(symbol, label, interval, { updateURL: true });
        closeMenu();
        toggle.focus();
      });

      option.addEventListener("keydown", (event) => {
        const focusNext = (delta) => {
          const currentIndex = Array.from(options).indexOf(option);
          const nextIndex =
            (currentIndex + delta + options.length) % options.length;
          options[nextIndex].focus();
        };

        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            focusNext(1);
            break;
          case "ArrowUp":
            event.preventDefault();
            focusNext(-1);
            break;
          case "Home":
            event.preventDefault();
            options[0]?.focus();
            break;
          case "End":
            event.preventDefault();
            options[options.length - 1]?.focus();
            break;
          case "Escape":
            event.preventDefault();
            closeMenu();
            toggle.focus();
            break;
          case "Enter":
          case " ":
            event.preventDefault();
            option.click();
            break;
          default:
            break;
        }
      });
    });

    document.addEventListener("click", (event) => {
      if (!chartSwitcher.contains(event.target)) {
        closeMenu();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    });

    chartSwitcher.dataset.ready = "true";
  }

  function applyChartSelection(symbol, label, interval, options = {}) {
    if (!symbol) {
      return;
    }

    const normalizedInterval = interval || "60";
    const formattedInterval = formatIntervalLabel(normalizedInterval);
    if (
      typeof options.hours === "number" &&
      Number.isFinite(options.hours) &&
      options.hours > 0
    ) {
      chartState.hours = options.hours;
    }

    chartState.symbol = symbol;
    chartState.label = label || symbol;
    chartState.interval = normalizedInterval;

    document.title = `LuckyGFX – ${chartState.label} Chart`;

    const descriptionEl = document.querySelector("[data-chart-description]");
    if (descriptionEl) {
      descriptionEl.textContent = `Currently viewing ${chartState.label} on the ${formattedInterval} timeframe.`;
    }

    const symbolEl = document.querySelector("[data-chart-symbol]");
    if (symbolEl) {
      symbolEl.textContent = chartState.label;
    }

    const intervalEl = document.querySelector("[data-chart-interval]");
    if (intervalEl) {
      intervalEl.textContent = formattedInterval;
    }

    const switcherLabelEl = document.querySelector(
      "[data-chart-switcher-label]"
    );
    if (switcherLabelEl) {
      switcherLabelEl.textContent = chartState.label;
    }

    const switcherOptions = document.querySelectorAll("[data-chart-option]");
    switcherOptions.forEach((opt) => {
      const isActive =
        opt.dataset.symbol === chartState.symbol &&
        (opt.dataset.interval || "60") === chartState.interval;
      opt.classList.toggle("is-active", isActive);
      opt.setAttribute("aria-checked", isActive ? "true" : "false");
    });

    if (options.updateURL) {
      const params = new URLSearchParams({
        symbol: chartState.symbol,
        label: chartState.label,
        interval: chartState.interval,
        hours: String(chartState.hours || 24),
      });
      const newUrl = `${window.location.pathname}?${params.toString()}`;
      window.history.replaceState({}, "", newUrl);
    }

    renderTradingViewChart(chartState.symbol, chartState.interval).catch(
      (error) => {
        console.error(error);
        showToast("Unable to load chart right now. Please try again soon.");
      }
    );

    if (isChartPage) {
      fetchOHLCData({
        symbol: chartState.symbol,
        timeframe: chartState.interval,
      });
    }
  }

  function renderTradingViewChart(symbol, interval) {
    const canvas = document.querySelector("[data-chart-canvas]");
    if (!canvas) {
      return Promise.resolve();
    }

    chartState.symbol = symbol;
    chartState.interval = interval;

    const theme = body.dataset.theme === "dark" ? "dark" : "light";
    const toolbarBg = theme === "dark" ? "#050917" : "#FFFFFF";
    if (!canvas.id) {
      canvas.id = "chart-canvas";
    }
    const containerId = canvas.id;

    canvas.innerHTML = "";

    return loadTradingViewScript().then((TradingView) => {
      if (!TradingView || typeof TradingView.widget !== "function") {
        throw new Error("TradingView widget is unavailable");
      }

      new TradingView.widget({
        container_id: containerId,
        symbol,
        interval,
        theme,
        autosize: true,
        style: "1",
        locale: "en",
        toolbar_bg: toolbarBg,
        enable_publishing: false,
        hide_side_toolbar: true,
        allow_symbol_change: true,
        width: "100%",
        height: "100%",
      });
    });
  }

  function loadTradingViewScript() {
    if (window.TradingView && typeof window.TradingView.widget === "function") {
      return Promise.resolve(window.TradingView);
    }
    if (tradingViewLoaderPromise) {
      return tradingViewLoaderPromise;
    }

    tradingViewLoaderPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://s3.tradingview.com/tv.js";
      script.async = true;
      script.onload = () => {
        if (
          window.TradingView &&
          typeof window.TradingView.widget === "function"
        ) {
          resolve(window.TradingView);
        } else {
          reject(new Error("TradingView library failed to initialise"));
        }
      };
      script.onerror = () => {
        reject(new Error("TradingView script failed to load"));
      };
      document.head.appendChild(script);
    });

    return tradingViewLoaderPromise;
  }

  function formatIntervalLabel(value) {
    const mapping = {
      1: "1m",
      3: "3m",
      5: "5m",
      15: "15m",
      30: "30m",
      45: "45m",
      60: "1H",
      120: "2H",
      180: "3H",
      240: "4H",
      360: "6H",
      480: "8H",
      720: "12H",
      D: "1D",
      W: "1W",
      M: "1M",
    };
    return mapping[value] || value;
  }

  function persistAuthCredentials(username, password) {
    const encoded = encodeBasicCredentials(username, password);
    localStorage.setItem(AUTH_STORAGE_KEY, encoded);
    localStorage.setItem(AUTH_USERNAME_KEY, username);
    authState = { username, encoded };
    return authState;
  }

  function getStoredAuthState() {
    try {
      const encoded = localStorage.getItem(AUTH_STORAGE_KEY);
      const username = localStorage.getItem(AUTH_USERNAME_KEY);
      if (!encoded || !username) {
        return null;
      }
      return { username, encoded };
    } catch (error) {
      console.warn("Unable to access stored credentials", error);
      return null;
    }
  }

  function clearStoredAuthState() {
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      localStorage.removeItem(AUTH_USERNAME_KEY);
    } catch (error) {
      console.warn("Unable to clear stored credentials", error);
    }
    authState = null;
  }

  function encodeBasicCredentials(username, password) {
    const token = `${username}:${password}`;
    try {
      return window.btoa(token);
    } catch (error) {
      return window.btoa(unescape(encodeURIComponent(token)));
    }
  }

  function getAuthorizationHeader() {
    if (!authState || !authState.encoded) {
      return null;
    }
    return `Basic ${authState.encoded}`;
  }

  function redirectToLogin() {
    if (isLoginPage) {
      return;
    }
    window.location.href = "/login";
  }

  function redirectToDashboard() {
    if (window.location.pathname === "/dashboard") {
      return;
    }
    window.location.href = "/dashboard";
  }

  function handleUnauthorized() {
    if (unauthorizedRedirectPending || isLoginPage) {
      return;
    }
    unauthorizedRedirectPending = true;
    clearStoredAuthState();
    showToast("Please log in to continue.");
    setTimeout(() => {
      redirectToLogin();
    }, 600);
  }

  function toggleSpinner(isVisible) {
    if (!spinnerOverlay) return;
    if (isVisible) {
      spinnerOverlay.classList.add("is-visible");
    } else {
      spinnerOverlay.classList.remove("is-visible");
    }
  }

  function showToast(message) {
    if (!toastStack) {
      console.warn("Toast stack is not available in the DOM.");
      return null;
    }

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");

    const messageEl = document.createElement("span");
    messageEl.className = "toast-message";
    messageEl.textContent = message;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "toast-close";
    closeButton.setAttribute("aria-label", "Dismiss notification");

    const closeIcon = document.createElement("i");
    closeIcon.setAttribute("data-feather", "x");

    closeButton.appendChild(closeIcon);
    toast.append(messageEl, closeButton);

    toastStack.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add("is-visible");
    });

    const removeToast = () => {
      if (!toast.isConnected) {
        return;
      }
      toast.classList.remove("is-visible");
      toast.addEventListener(
        "transitionend",
        () => {
          toast.remove();
        },
        { once: true }
      );
    };

    const timeoutId = window.setTimeout(removeToast, TOAST_TIMEOUT);
    toast.dataset.timeoutId = String(timeoutId);

    closeButton.addEventListener("click", () => {
      window.clearTimeout(timeoutId);
      removeToast();
    });

    if (window.feather) {
      window.feather.replace();
    }

    return toast;
  }

  function hideToast(toast) {
    if (!toast) return;
    const timeoutId = Number(toast.dataset.timeoutId);
    if (Number.isFinite(timeoutId)) {
      window.clearTimeout(timeoutId);
    }
    if (!toast.isConnected) {
      return;
    }
    toast.classList.remove("is-visible");
    toast.addEventListener(
      "transitionend",
      () => {
        toast.remove();
      },
      { once: true }
    );
  }

  // Expose helpers for debugging if needed
  window.AhmedAgentUI = {
    showToast,
    hideToast,
    toggleSpinner,
  };
});
