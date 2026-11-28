// Stub for https://apis.google.com/js/api.js in the e2e browser (e2e/fixtures.ts): a fake
// `gapi.load("picker")` and `google.picker` whose dialog "picks" the next entry a spec queued in
// window.__e2ePicks (an array of files, or null for Cancel). Each open is logged in
// window.__e2ePickerOpened ({ title, views }) for assertions.
(function () {
  function DocsView(viewId) {
    this.viewId = viewId;
    this.mimeTypes = null;
    this.parent = null;
  }
  DocsView.prototype.setMimeTypes = function (m) { this.mimeTypes = m; return this; };
  DocsView.prototype.setParent = function (p) { this.parent = p; return this; };
  DocsView.prototype.setSelectFolderEnabled = function () { return this; };
  DocsView.prototype.setIncludeFolders = function () { return this; };
  DocsView.prototype.setMode = function () { return this; };
  DocsView.prototype.setEnableDrives = function (on) { this.drives = on; return this; };

  function PickerBuilder() {
    this.views = [];
    this.title = "";
    this.cb = function () {};
    this.features = [];
    this.token = null;
  }
  PickerBuilder.prototype.enableFeature = function (f) { this.features.push(f); return this; };
  PickerBuilder.prototype.setOAuthToken = function (t) { this.token = t; return this; };
  ["setDeveloperKey", "setAppId", "setLocale"].forEach(function (m) {
    PickerBuilder.prototype[m] = function () { return this; };
  });
  PickerBuilder.prototype.addView = function (v) { this.views.push(v); return this; };
  PickerBuilder.prototype.setTitle = function (t) { this.title = t; return this; };
  PickerBuilder.prototype.setCallback = function (cb) { this.cb = cb; return this; };
  PickerBuilder.prototype.build = function () {
    var self = this;
    return {
      setVisible: function (on) {
        if (!on) return;
        window.__e2ePickerOpened = window.__e2ePickerOpened || [];
        window.__e2ePickerOpened.push({
          title: self.title,
          // The access token's account (the fake's `e2e-at:<email>`), never a real token.
          account: typeof self.token === "string" ? self.token.replace(/^e2e-at:/, "") : null,
          features: self.features,
          views: self.views.map(function (v) { return { viewId: v.viewId, mimeTypes: v.mimeTypes, parent: v.parent, drives: Boolean(v.drives) }; }),
        });
        var picks = window.__e2ePicks || [];
        var next = picks.length ? picks.shift() : null;
        setTimeout(function () {
          self.cb(next ? { action: "picked", docs: next } : { action: "cancel" });
        }, 50);
      },
      dispose: function () {},
    };
  };

  window.google = window.google || {};
  window.gapi = {
    load: function (name, cb) {
      window.google.picker = {
        DocsView: DocsView,
        PickerBuilder: PickerBuilder,
        ViewId: { DOCS: "docs", FOLDERS: "folders" },
        Feature: { MULTISELECT_ENABLED: "multiselect", SUPPORT_DRIVES: "supportDrives" },
        Action: { PICKED: "picked", CANCEL: "cancel" },
        DocsViewMode: { LIST: "list" },
      };
      var done = typeof cb === "function" ? cb : cb.callback;
      setTimeout(done, 0);
    },
  };
})();
