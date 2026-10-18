# Snow Route / 2027

A pink winter itinerary with 一二布布 character artwork and a password-protected entry page.

Character artwork: 黄小B, sourced from the [小熊一二和布布 sticker pack](https://getstickerpack.com/stickers/xiao-xiong-yi-er-he-bu-bu-credits-to-huang-xiaob). The original character artwork is stored in `assets/yier-bubu.png`; character rights remain with their owner.

## Publish with GitHub Pages

In **Settings → Pages → Build and deployment**, select:

- **Source:** Deploy from a branch
- **Branch:** `main`
- **Folder:** `/ (root)`

Click **Save**. The expected URL is https://lamedts.github.io/202701-jp/ once GitHub finishes deploying.

Only the encrypted `index.html` is published as the itinerary. `.nojekyll` enables ordinary static hosting.

## Edit or change the website password

The editable page is `.private/itinerary.html` on the original computer. This folder is ignored by Git; keep a private backup because cloning this repository does not restore it.

After editing it, rebuild with Node.js 22 or later:

```sh
node scripts/protect.mjs
```

Enter the website password at the hidden prompt. Commit and push the rebuilt `index.html`. The password itself is never saved in the repository. Refreshing the page locks it again; there is no persistent login.

The page uses PBKDF2-SHA-256 (600,000 iterations, random salt) and AES-256-GCM (random IV). Visitors decrypt the page in their browser. Choose a strong password: the published encrypted file can be downloaded and password guesses can be tested offline. The lock does not hide any unencrypted content already present in old Git commits. Public reference photographs remain public on their original hosts.

Run the encryption and unlock-flow checks with:

```sh
node --test scripts/protect.test.mjs
```
