/**
 * apps-script-recorder.gs
 *
 * Google Apps Script that receives session-recording batches from
 * recorder.js (running on bundle-research.xyz) and writes them as files
 * into a Google Drive folder that YOU own.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  ONE-TIME SETUP (Mohamed — follow these steps)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  1. In Google Drive, create a folder called "BundleRecorder Sessions"
 *     (or any name you like).
 *
 *  2. Open that folder. Look at the URL in your browser. It ends in:
 *       https://drive.google.com/drive/folders/<LONG_ID>
 *     Copy that <LONG_ID>.
 *
 *  3. Go to https://script.google.com → New project.
 *     Delete the default code. Paste THIS ENTIRE FILE.
 *     Replace PASTE_FOLDER_ID_HERE on the line below with the ID you copied.
 *
 *  4. Click the "Save" disk icon (Ctrl+S). Give the project a name like
 *     "Bundle Recorder".
 *
 *  5. Click Deploy → New deployment → gear icon → Web app.
 *     - Description: "Bundle Recorder v1"
 *     - Execute as: Me (yourname@gmail.com)
 *     - Who has access: Anyone
 *     Click Deploy. Authorize when prompted (the script needs Drive write).
 *
 *  6. Copy the Web app URL (looks like
 *     https://script.google.com/macros/s/AKfycb…/exec).
 *
 *  7. In the site repo, open recorder.js and replace
 *     PASTE_RECORDER_APPS_SCRIPT_URL_HERE with that URL. Commit & push.
 *
 *  8. To install Drive Desktop sync (so recordings land on your laptop):
 *       https://www.google.com/drive/download/
 *     Pick the "BundleRecorder Sessions" folder for offline sync. New
 *     session folders will appear in your local Drive folder within seconds
 *     of a visitor closing the tab.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  HOW THE STORAGE IS LAID OUT
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  BundleRecorder Sessions/
 *  └── rec_<uuid>/
 *      ├── metadata.json          (visitor info: URL, viewport, UA, …)
 *      ├── batch_1738745120000.json
 *      ├── batch_1738745125000.json
 *      └── batch_1738745130000.json
 *
 *  Each batch is a JSON array of rrweb events. The replay.html tool sorts
 *  batches by the timestamp in the filename and concatenates them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  QUOTAS & LIMITS
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  Apps Script free tier (per Google account):
 *    - 90 minutes script execution / day  (each POST takes ~0.5s, so this
 *                                          allows ~10,000 batches/day)
 *    - 20,000 URL fetches / day            (we don't make outbound fetches)
 *    - File creation: unlimited
 *
 *  Google Drive free tier: 15 GB.
 *  A typical 5-minute session is ~2 MB of JSON, so 15 GB ≈ 7,500 sessions.
 *
 *  When quotas approach, archive + zip old sessions (or upgrade).
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

// ============ CONFIGURATION ============
var FOLDER_ID = 'PASTE_FOLDER_ID_HERE';

// Maximum POST size we'll accept (raw JSON). Apps Script can handle up to
// ~50 MB but enormous batches usually indicate misuse — clamp to 5 MB.
var MAX_BODY_BYTES = 5 * 1024 * 1024;

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

    // Write metadata.json once (if not already present)
    if (data.metadata && !hasFile(sessionFolder, 'metadata.json')) {
      sessionFolder.createFile(
        'metadata.json',
        JSON.stringify(data.metadata, null, 2),
        MimeType.PLAIN_TEXT
      );
    }

    // Write the batch
    var events = data.events;
    if (events && events.length > 0) {
      var batchTime = Number(data.batchTime) || (new Date()).getTime();
      var batchName = 'batch_' + batchTime + '.json';
      // If a batch with this exact timestamp already exists (clock collision),
      // append a small suffix to avoid overwriting
      if (hasFile(sessionFolder, batchName)) {
        batchName = 'batch_' + batchTime + '_' +
                    Math.floor(Math.random() * 1000) + '.json';
      }
      sessionFolder.createFile(batchName, JSON.stringify(events), MimeType.PLAIN_TEXT);
    }

    return jsonOut({
      status: 'ok',
      sessionId: sessionId,
      eventsWritten: events ? events.length : 0
    });
  } catch (err) {
    // Log to Apps Script execution log so we can see failures
    console.error('doPost failed: ' + (err && err.stack ? err.stack : err));
    return jsonOut({ status: 'error', message: String(err) });
  }
}

function doGet(e) {
  // Health check — visiting the URL in a browser will show this.
  return jsonOut({
    status: 'ok',
    service: 'BundleRecorder',
    note: 'POST batches to this endpoint. See apps-script-recorder.gs for shape.'
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
  // Allow letters, digits, dashes, underscores. Length 6–80.
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
