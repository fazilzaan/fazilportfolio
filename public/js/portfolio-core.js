/**
 * Portfolio storage helpers backed by Cloud Firestore.
 * Requires firebase-config.js + Firebase compat SDKs loaded first.
 */
(function (global) {
  const COLLECTION = "projects";
  let db = null;
  let auth = null;
  let initPromise = null;

  function ensureConfigured() {
    const cfg = global.FIREBASE_CONFIG;
    if (!cfg || !cfg.projectId || cfg.projectId === "YOUR_PROJECT_ID" || cfg.apiKey === "YOUR_API_KEY") {
      throw new Error(
        "Firebase is not configured. Update firebase-config.js with your web app config from the Firebase Console."
      );
    }
    return cfg;
  }

  function initFirebase() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (typeof firebase === "undefined") {
        throw new Error("Firebase SDK not loaded");
      }
      const cfg = ensureConfigured();
      if (!firebase.apps.length) {
        firebase.initializeApp(cfg);
      }
      db = firebase.firestore();
      // Auth SDK is only required on admin pages
      auth = typeof firebase.auth === "function" ? firebase.auth() : null;
      return { db, auth };
    })();

    return initPromise;
  }

  function normalizeProject(project) {
    const copy = { ...(project || {}) };
    copy.id = copy.id || "";
    copy.title = copy.title || "";
    copy.credits = copy.credits || "";
    copy.video = copy.video || "";
    copy.specialties = Array.isArray(copy.specialties) ? copy.specialties : [];
    copy.categories =
      copy.categories && typeof copy.categories === "object" ? copy.categories : {};
    copy.isRecent = Boolean(copy.isRecent);
    copy.isDeleted = Boolean(copy.isDeleted);
    return copy;
  }

  function toFirestorePayload(project) {
    const normalized = normalizeProject(project);
    return {
      id: normalized.id,
      title: normalized.title,
      credits: normalized.credits,
      video: normalized.video,
      specialties: normalized.specialties,
      categories: normalized.categories,
      isRecent: normalized.isRecent,
      isDeleted: normalized.isDeleted,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }

  async function getCustomProjects() {
    await initFirebase();
    const snap = await db.collection(COLLECTION).get();
    return snap.docs.map((doc) => normalizeProject({ id: doc.id, ...doc.data() }));
  }

  async function saveCustomProject(project) {
    await initFirebase();
    if (!project || !project.id) {
      throw new Error("Project must include an id");
    }
    if (!auth || !auth.currentUser) {
      throw new Error("You must be signed in to save projects");
    }
    const payload = toFirestorePayload(project);
    await db.collection(COLLECTION).doc(project.id).set(payload, { merge: true });
    return normalizeProject(payload);
  }

  async function deleteCustomProject(id) {
    await initFirebase();
    if (!auth || !auth.currentUser) {
      throw new Error("You must be signed in to delete projects");
    }
    await db.collection(COLLECTION).doc(id).delete();
  }

  async function getCombinedProjects() {
    await initFirebase();
    const fromDb = await getCustomProjects();
    const active = fromDb.filter((item) => !item.isDeleted);

    if (active.length > 0) {
      return active.sort((a, b) => a.title.localeCompare(b.title));
    }

    // Fallback to local seed file when Firestore is empty / not seeded yet
    const defaults = (global.DEFAULT_PROJECTS || []).map(normalizeProject);
    return defaults
      .filter((item) => !item.isDeleted)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async function seedDefaultsIfEmpty() {
    await initFirebase();
    if (!auth || !auth.currentUser) return { seeded: false, reason: "not-authenticated" };

    const existing = await getCustomProjects();
    const active = existing.filter((p) => !p.isDeleted);
    if (active.length > 0) return { seeded: false, reason: "already-has-data" };

    const defaults = global.DEFAULT_PROJECTS || [];
    for (const proj of defaults) {
      await saveCustomProject({ ...proj, videoFile: null, isDeleted: false });
    }
    return { seeded: true, count: defaults.length };
  }

  function getFirebaseAuth() {
    return auth;
  }

  function getFirestore() {
    return db;
  }

  function onAuthStateChanged(callback) {
    return initFirebase().then(() => {
      if (!auth) {
        throw new Error("Firebase Auth SDK is not loaded on this page");
      }
      return auth.onAuthStateChanged(callback);
    });
  }

  async function signIn(email, password) {
    await initFirebase();
    if (!auth) {
      throw new Error("Firebase Auth SDK is not loaded on this page");
    }
    return auth.signInWithEmailAndPassword(email, password);
  }

  async function signOutAdmin() {
    await initFirebase();
    if (!auth) {
      throw new Error("Firebase Auth SDK is not loaded on this page");
    }
    return auth.signOut();
  }

  /**
   * Upload a video to Cloudinary using an unsigned preset (browser-safe).
   */
  function uploadToCloudinary(file, onProgress) {
    const cfg = global.CLOUDINARY_CONFIG || {};
    if (!cfg.cloudName || !cfg.uploadPreset) {
      return Promise.reject(
        new Error("Cloudinary is not configured. Set cloudName and uploadPreset in firebase-config.js")
      );
    }

    return new Promise((resolve, reject) => {
      const url = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/video/upload`;
      const formData = new FormData();
      formData.append("file", file);
      formData.append("upload_preset", cfg.uploadPreset);
      if (cfg.folder) formData.append("folder", cfg.folder);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || !onProgress) return;
        onProgress(Math.round((event.loaded / event.total) * 100));
      };

      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          reject(new Error("Invalid response from Cloudinary"));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) {
          resolve({
            url: data.secure_url,
            publicId: data.public_id,
            format: data.format,
            bytes: data.bytes
          });
          return;
        }
        const message =
          (data && data.error && data.error.message) ||
          `Cloudinary upload failed (${xhr.status})`;
        reject(new Error(message));
      };

      xhr.onerror = () => reject(new Error("Network error while uploading to Cloudinary"));
      xhr.send(formData);
    });
  }

  global.initFirebase = initFirebase;
  global.getCustomProjects = getCustomProjects;
  global.saveCustomProject = saveCustomProject;
  global.deleteCustomProject = deleteCustomProject;
  global.getCombinedProjects = getCombinedProjects;
  global.seedDefaultsIfEmpty = seedDefaultsIfEmpty;
  global.getFirebaseAuth = getFirebaseAuth;
  global.getFirestore = getFirestore;
  global.onAuthStateChanged = onAuthStateChanged;
  global.signInAdmin = signIn;
  global.signOutAdmin = signOutAdmin;
  global.uploadToCloudinary = uploadToCloudinary;
})(window);
