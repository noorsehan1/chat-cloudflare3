// SEBELUM
let restoredCount = 0;
for (const ws of webSockets) {
  try {
    if (!ws || ws.readyState !== 1) continue;   // <-- skip, tidak dibersihkan
    await this._restoreSingleWebSocket(ws);
    restoredCount++;
  } catch(e) {
    console.error('[RESTORE] WS restore failed:', e);
  }
}

// SESUDAH
let restoredCount = 0;
let deadCount = 0;
for (const ws of webSockets) {
  try {
    // 🔥 CEK WS MATI — kalau mati, tandai cleanup done & skip
    if (!ws || ws.readyState !== 1) {
      deadCount++;
      try {
        const st = _wsCleanupState.get(ws);
        if (st) {
          st.cleanupDone = true;
          st.cleaning = false;
        } else {
          _wsCleanupState.set(ws, { cleanupDone: true, cleaning: false, cleanupStart: null });
        }
      } catch(e) {}
      try { this.wsSet.delete(ws); } catch(e) {}
      continue;
    }
    await this._restoreSingleWebSocket(ws);
    restoredCount++;
  } catch(e) {
    console.error('[RESTORE] WS restore failed:', e);
  }
}
console.log(`[RESTORE] Restored ${restoredCount} live WS, skipped ${deadCount} dead WS`);
