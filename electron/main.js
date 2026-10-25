// Application de bureau « Voyages immobiles » : enveloppe Electron autour de la page web.
// L'accès au casque passe par WebUSB (Tango ADB), comme dans Chrome ;
// ce fichier se charge seulement d'autoriser l'USB et de choisir le casque.
const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 720,
    minHeight: 560,
    title: "Voyages immobiles · Chargeur 360",
    backgroundColor: "#f4f2ee",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const ses = win.webContents.session;

  // Fenêtre de choix du périphérique USB : Chromium l'affiche nativement,
  // Electron nous la délègue.
  ses.on("select-usb-device", async (event, details, callback) => {
    event.preventDefault();
    const list = details.deviceList || [];
    if (list.length === 0) {
      await dialog.showMessageBox(win, {
        type: "warning",
        title: "Aucun casque détecté",
        message: "Aucun casque Meta Quest n'est détecté.",
        detail:
          "Vérifiez que :\n" +
          "• le casque est allumé et branché avec un câble USB-C de données ;\n" +
          "• le mode développeur est activé ;\n" +
          "• SideQuest, Meta Quest Developer Hub ou adb sont fermés.\n\n" +
          "Débranchez puis rebranchez le câble si besoin, et réessayez.",
        buttons: ["OK"],
      });
      callback();
      return;
    }
    if (list.length === 1) {
      callback(list[0].deviceId);
      return;
    }
    const labels = list.map(
      (d) => `${d.productName || "Appareil Android"}${d.serialNumber ? " · " + d.serialNumber : ""}`
    );
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      title: "Choisir un casque",
      message: "Plusieurs casques sont branchés. Lequel préparer ?",
      buttons: [...labels, "Annuler"],
      cancelId: labels.length,
      defaultId: 0,
    });
    callback(response < list.length ? list[response].deviceId : undefined);
  });

  // Autorisations : USB (casques) et maintien de l'écran allumé pendant les transferts.
  ses.setPermissionCheckHandler((_wc, permission) =>
    permission === "usb" || permission === "screen-wake-lock"
  );
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === "screen-wake-lock")
  );
  ses.setDevicePermissionHandler((details) => details.deviceType === "usb");

  // Les liens externes s'ouvrent dans le navigateur, jamais dans l'application.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // Confirmation de fermeture pendant un envoi (la page pose beforeunload).
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      title: "Envoi en cours",
      message: "Un envoi vers le casque est en cours.",
      detail: "Fermer maintenant interrompra le transfert. La vidéo incomplète sera à renvoyer.",
      buttons: ["Continuer l'envoi", "Fermer quand même"],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, "..", "app", "index.html"));
  win.on("closed", () => (win = null));
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
