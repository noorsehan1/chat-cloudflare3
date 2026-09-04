// STEP 3: Jika ada room lama, hapus data kursi dan point di room tersebut
if (oldRoom && oldSeat !== null) {
  const oldRoomData = this._roomsDataCache[oldRoom];
  if (oldRoomData) {
    // Hapus kursi
    if (oldRoomData.seats && oldRoomData.seats[oldSeat]) {
      delete oldRoomData.seats[oldSeat];
    }
    // Hapus point
    if (oldRoomData.points && oldRoomData.points[oldSeat]) {
      delete oldRoomData.points[oldSeat];
    }
    
    // Simpan perubahan room lama ke storage
    await this._syncRoomToStorage(oldRoom);
    
    // Broadcast ke room lama bahwa kursi dihapus
    this.broadcast(oldRoom, ["removeKursi", oldRoom, oldSeat]);
    
    // Cek apakah room lama kosong
    await this._deleteRoomIfEmpty(oldRoom);
  }
}
