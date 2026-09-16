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

  const R2_WORKER_URL = "https://fazil-r2-upload.zaanfazil.workers.dev/";

  /**
   * Upload a video to Cloudflare R2 via Cloudflare Worker.
   * Works on both localhost and live hosting (Firebase) with no file size limits.
   */
  async function uploadToR2(file, onProgress) {
    const filename = file.name || "video.mp4";
    const contentType = file.type || "video/mp4";

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", R2_WORKER_URL);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.setRequestHeader("X-Filename", filename);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || !onProgress) return;
        onProgress(Math.round((event.loaded / event.total) * 100));
      };

      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
          resolve({
            url: data.url,
            publicId: data.key,
            format: filename.split(".").pop(),
            bytes: file.size
          });
        } else {
          const msg = (data && data.error) || `R2 Worker upload failed (${xhr.status})`;
          reject(new Error(msg));
        }
      };

      xhr.onerror = () =>
        reject(
          new Error("Network error while uploading to Cloudflare R2 Worker")
        );

      xhr.send(file);
    });
  }

  /**
   * Primary uploader: uses Cloudflare R2 Worker for all video uploads (no file size limit, 0 bandwidth fee).
   */
  async function uploadToCloudinary(file, onProgress) {
    try {
      return await uploadToR2(file, onProgress);
    } catch (r2Error) {
      console.warn("R2 Worker upload failed, trying Cloudinary fallback...", r2Error.message);
      return uploadToCloudinaryDirect(file, onProgress);
    }
  }

  function uploadToCloudinaryDirect(file, onProgress) {
    const cfg = global.CLOUDINARY_CONFIG || {};
    if (!cfg.cloudName || !cfg.uploadPreset) {
      return Promise.reject(
        new Error("Neither Cloudflare R2 nor Cloudinary is configured.")
      );
    }

    const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB chunks
    const totalSize = file.size;
    const url = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/video/upload`;

    // For files <= 10MB, standard single request
    if (totalSize <= CHUNK_SIZE) {
      return uploadCloudinaryPart(file, 0, totalSize, totalSize, null, cfg, url, onProgress);
    }

    // For files > 10MB (e.g. 152.8 MB), upload in 10MB chunks using X-Unique-Upload-Id & Content-Range
    const uniqueUploadId = "cld_up_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);

    return (async () => {
      let start = 0;
      let lastResponse = null;

      while (start < totalSize) {
        const end = Math.min(start + CHUNK_SIZE, totalSize);
        const chunk = file.slice(start, end);
        const contentRange = `bytes ${start}-${end - 1}/${totalSize}`;

        lastResponse = await uploadCloudinaryPart(
          chunk,
          start,
          end,
          totalSize,
          { uniqueUploadId, contentRange },
          cfg,
          url,
          (chunkProgress) => {
            if (onProgress) {
              const uploadedBytes = start + (chunk.size * chunkProgress) / 100;
              const overallPercent = Math.min(99, Math.round((uploadedBytes / totalSize) * 100));
              onProgress(overallPercent);
            }
          }
        );

        start = end;
      }

      if (onProgress) onProgress(100);
      return lastResponse;
    })();
  }

  function uploadCloudinaryPart(blob, start, end, totalSize, chunkHeaders, cfg, url, onProgress) {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", blob);
      formData.append("upload_preset", cfg.uploadPreset);
      if (cfg.folder) formData.append("folder", cfg.folder);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);

      if (chunkHeaders) {
        xhr.setRequestHeader("X-Unique-Upload-Id", chunkHeaders.uniqueUploadId);
        xhr.setRequestHeader("Content-Range", chunkHeaders.contentRange);
      }

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
        if (xhr.status >= 200 && xhr.status < 300) {
          if (data && data.secure_url) {
            resolve({
              url: data.secure_url,
              publicId: data.public_id,
              format: data.format,
              bytes: data.bytes
            });
          } else {
            // Intermediate 200 OK chunk response
            resolve(data || { success: true });
          }
          return;
        }
        const message =
          (data && data.error && data.error.message) ||
          `Cloudinary upload failed (${xhr.status})`;
        reject(new Error(message));
      };

      xhr.onerror = () => reject(new Error("Network error while uploading video to Cloudinary"));
      xhr.send(formData);
    });
  }

  global.uploadToR2 = uploadToR2;
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
