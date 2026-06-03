/**
 * apps-script-recorder.gs  (v2 — snapshot/event payload)
 *
 * Receives session-recording payloads from recorder.js (running on
 * bundle-research.xyz) and writes them as files into a Google Drive
 * folder you own. The recorder switched from rrweb (DOM mutation
 * tracking) to html2canvas (periodic JPEG snapshots), so this script
 * now accepts three distinct payload `type` values:
 *
 *   type: "meta"      → write metadata.json once per session folder
 *   type: "snapshot"  → save a JPEG file inside the session folder
 *   type: "events"    → append a JSONL file inside the session folder
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  RE-DEPLOY STEPS (Mohamed — do this once)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  1. Go to script.google.com → open your "Bundle Recorder" project
 *  2. Replace the entire script with THIS file's contents
 *  3. Keep the FOLDER_ID line below pointing at your existing
 *     "BundleRecorder Sessions" folder
 *  4. Click Deploy → Manage Deployments → pencil edit icon on the
 *     existing deployment → Version: New version → Deploy
 *  5. Web app URL stays the same — recorder.js needs no update
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  HOW THE STORAGE IS LAID OUT
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  BundleRecorder Sessions/
 *  └── rec_<uuid>/
 *      ├── metadata.json          (visitor: URL, viewport, UA, timestamps)
 *      ├── snap_0000_1738745120000.jpg
 *      ├── snap_0001_1738745125000.jpg
 *      ├── snap_0002_1738745130000.jpg
 *      ├── events_1738745125000.jsonl
 *      └── events_1738745130000.jsonl
 *
 *  Each snapshot is a real JPEG file you can preview directly in Drive.
 *  Each event batch is a JSON-lines file with clicks / scrolls / etc.
 *  The replay tool reassembles them into a slideshow.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

// ============ CONFIGURATION ============
var FOLDER_ID = '1_JWuTwQbqukglYAtN0gtc52Km4TpXpSG';

// Maximum POST size we'll accept (raw JSON). Snapshots can be up to ~600 KB
// after base64 inflation; we cap a single request at 2 MB to leave room.
var MAX_BODY_BYTES = 2 * 1024 * 1024;

// =======================================

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut({ status: 'error', message: 'no body' });
    }
    if (e.postData.contents.length > MAX_BODY_BYTES) {
      return jsonOut({ status: 'error', message: 'body too large' });
    }

    var data = JSON.parse(e.postData.contents);
    var sessionId = sanitizeSessionId(data.sessionId);
    if (!sessionId) {
      return jsonOut({ status: 'error', message: 'missing or invalid sessionId' });
    }

    var root = DriveApp.getFolderById(FOLDER_ID);
    var sessionFolder = getOrCreateChildFolder(root, sessionId);

    var type = data.type || 'snapshot';  // default = snapshot for back-compat

    if (type === 'meta') {
      // Write metadata.json once
      if (data.metadata && !hasFile(sessionFolder, 'metadata.json')) {
        sessionFolder.createFile(
          'metadata.json',
          JSON.stringify(data.metadata, null, 2),
          MimeType.PLAIN_TEXT
        );
      }
      return jsonOut({ status: 'ok', type: 'meta', sessionId: sessionId });
    }

    if (type === 'snapshot') {
      // Decode base64 JPEG and write as a real .jpg file in Drive
      if (!data.jpeg) {
        return jsonOut({ status: 'error', message: 'missing jpeg' });
      }
      var bytes;
      try { bytes = Utilities.base64Decode(data.jpeg); }
      catch (err) {
        return jsonOut({ status: 'error', message: 'jpeg decode failed' });
      }

      var idx = String(Number(data.index) || 0);
      while (idx.length < 4) idx = '0' + idx;
      var ts = Number(data.timestamp) || (new Date()).getTime();
      var name = 'snap_' + idx + '_' + ts + '.jpg';

      // Sidecar: tiny JSON next to each JPEG with the scroll + mouse
      // position at the moment of capture. Replay reads this to know
      // where to draw the cursor and what scroll offset to show.
      var sidecar = {
        index: data.index,
        timestamp: data.timestamp,
        scrollX: data.scrollX || 0,
        scrollY: data.scrollY || 0,
        mouseX: data.mouseX || 0,
        mouseY: data.mouseY || 0,
        viewport: data.viewport || ''
      };

      var blob = Utilities.newBlob(bytes, 'image/jpeg', name);
      sessionFolder.createFile(blob);
      sessionFolder.createFile(
        name.replace(/\.jpg$/, '.json'),
        JSON.stringify(sidecar),
        MimeType.PLAIN_TEXT
      );

      return jsonOut({
        status: 'ok', type: 'snapshot', sessionId: sessionId,
        index: data.index, sizeBytes: bytes.length
      });
    }

    if (type === 'events') {
      if (!data.events || !data.events.length) {
        return jsonOut({ status: 'ok', type: 'events', skipped: 'empty' });
      }
      var ts2 = Number(data.batchTime) || (new Date()).getTime();
      var batchName = 'events_' + ts2 + '.jsonl';
      if (hasFile(sessionFolder, batchName)) {
        batchName = 'events_' + ts2 + '_' +
                    Math.floor(Math.random() * 1000) + '.jsonl';
      }
      var lines = data.events.map(function(ev){
        return JSON.stringify(ev);
      }).join('\n');
      sessionFolder.createFile(batchName, lines, MimeType.PLAIN_TEXT);
      return jsonOut({
        status: 'ok', type: 'events', sessionId: sessionId,
        eventsWritten: data.events.length
      });
    }

    return jsonOut({ status: 'error', message: 'unknown type: ' + type });
  } catch (err) {
    console.error('doPost failed: ' + (err && err.stack ? err.stack : err));
    return jsonOut({ status: 'error', message: String(err) });
  }
}

function doGet(e) {
  return jsonOut({
    status: 'ok',
    service: 'BundleRecorder',
    version: 2,
    note: 'POST snapshot/event/meta payloads. See apps-script-recorder.gs.'
  });
}

// ============ HELPERS ============

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeSessionId(raw) {
  if (typeof raw !== 'string') return null;
  var clean = raw.replace(/[^a-zA-Z0-9_\-]/g, '');
  if (clean.length < 6 || clean.length > 80) return null;
  return clean;
}

function getOrCreateChildFolder(parent, name) {
  var iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

function hasFile(folder, name) {
  return folder.getFilesByName(name).hasNext();
}
