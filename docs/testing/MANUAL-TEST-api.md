# Manual test: Local API

The automated test runs the real helper in Chromium against a stand-in Google Photos. These steps are
the real proof against your library. Searching is rationed by Google: keep finds by name to a few a
minute.

1. Reload Pixlixir. Open Google Photos in a tab. Open **Settings**.
2. Under **Local API > Helper**, copy **Install** and run it in PowerShell (Windows) or Terminal.
3. Switch **Local API** on and allow Chrome's question. The pill turns **Running** within a few seconds.
4. Copy the **Key**. In PowerShell:
   ```powershell
   $h = @{ Authorization = "Bearer <key>" }
   irm http://127.0.0.1:8765/v1/status -Headers $h
   irm "http://127.0.0.1:8765/v1/items?fileName=<a file name you know>" -Headers $h
   ```
   or with curl: `curl -H "Authorization: Bearer <key>" "http://127.0.0.1:8765/v1/items?fileName=IMG_1234.jpg"`.
5. Check the item: its date, place, albums. Open its `webUrl`.
6. Download it: `.../v1/items/<mediaKey>/original` saves the original file; compare with the one in Photos.
7. Switch **Local API** off: the same call now fails to connect.
8. Run **Uninstall**. Settings shows "The helper is not installed" when you switch it on again.

Note what goes wrong, and any `429` answers with how many finds you had made.
