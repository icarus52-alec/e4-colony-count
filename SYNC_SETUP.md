# E4 private sync setup

The app uses the same Firebase project and Google owner account as Culture Media Recipe Library. Counts, sample/date/salinity/replicate labels, notes and original-photo filenames sync after the owner signs in. Photos do not upload to Firebase. Other visitors can use their own device locally; they cannot see the owner's E4 data.

Before using sync, open Firebase Console for `media-recipe-calculator-6610c` → Firestore Database → Rules. Replace the current rules with the complete contents of [firestore.rules](firestore.rules) and click Publish. The file retains the recipe library's existing rules and adds an owner-only `/e4Owners/{userId}/...` path. Do not publish only the new match block or remove the recipe rules.

Then open the E4 app on the first device, select **登入以同步**, and choose the same Google owner account. Wait for **已同步 · 登出**. Open it on the second device, sign into that same account, and wait for the same status. Existing records from both devices are merged by sample name and date. If the same record was edited on both devices, the newer version becomes current and an older local version is preserved as a separate named copy.

For an exact match with the phone's original photo, first take the picture using the phone's camera app and keep it in the photo library. Then choose that picture in the E4 app; the app records the chosen file's name and keeps a compressed preview locally. Check or edit **原圖檔名** if the browser shows a renamed file. **下載照片對照 CSV** lists sample, date, salinity, replicate, and original filename for matching after transferring originals to a computer. On a second device the index is visible, but the photo preview is not. Full JSON/ZIP backups still include local compressed previews, not the camera originals. Keep those backups separately; the sync indicator is not a photo backup.

If the indicator says **同步失敗，點此重試**, check that the rules were published, the Google account matches the owner account, and the device is online. Local records remain available if cloud sync fails.
