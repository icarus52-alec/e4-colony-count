# E4 private sync setup

The app uses the same Firebase project and Google owner account as Culture Media Recipe Library. Counts and photos stay in the browser until the owner signs in. Other visitors can use their own device locally; they cannot see the owner's E4 data.

Before using sync, open Firebase Console for `media-recipe-calculator-6610c` → Firestore Database → Rules. Replace the current rules with the complete contents of [firestore.rules](firestore.rules) and click Publish. The file retains the recipe library's existing rules and adds an owner-only `/e4Owners/{userId}/...` path. Do not publish only the new match block or remove the recipe rules.

Then open the E4 app on the first device, select **登入以同步**, and choose the same Google owner account. Wait for **已同步 · 登出**. Open it on the second device, sign into that same account, and wait for the same status. Existing records from both devices are merged by sample name and date. If the same record was edited on both devices, the newer version becomes current and an older local version is preserved as a separate named copy.

Photos are compressed in the browser and stored as private Firestore documents in small chunks; they download to the second device when viewed or exported. Large collections may approach Firebase's free Firestore quotas, so continue to download full JSON/ZIP backups regularly. The sync indicator is not a replacement for a backup.

If the indicator says **同步失敗，點此重試**, check that the rules were published, the Google account matches the owner account, and the device is online. Local records remain available if cloud sync fails.
