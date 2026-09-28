# Chrunos Downloader

<p align="center">
  <img src="logo/icon128.png" width="96" height="96" alt="Chrunos Downloader Logo">
</p>

<h3 align="center">A Chrome extension to download YouTube videos in 4K, extract MP3 audio, and save YouTube Shorts — right from your browser.</h3>

<p align="center">
  <a href="#key-features">Key Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#faq">FAQ</a> •
  <a href="https://github.com/CodyChrunos/Youtube-Downloader-Extension/issues/new/choose">Report Issue</a>
</p>

---

## Key Features

- **4K / 8K Video Downloads** — Save YouTube videos in ultra HD quality, up to 2160p and beyond when available.
- **YouTube → MP3** — Extract high-quality 320kbps MP3 audio directly from any video.
- **YouTube Shorts** — One-click download for Shorts content.
- **Merged Video + Audio** — Automatically muxes separate video and audio streams into a single file (no extra software needed).
- **Parallel & Resumable** — Streams are fetched in parallel Range fragments and resume gracefully on network hiccups.
- **Private Video Support** — Download private and member-only videos you have access to.
- **No Ads, No Tracking** — Clean, lightweight, and privacy-friendly.

## Installation

This extension is distributed as a downloadable zip via GitHub Releases and is intended for Chromium-based browsers (Chrome, Brave, Opera, Vivaldi, Edge, etc.).

### Steps

1. **Download the zip**
   Go to the [latest release](https://github.com/CodyChrunos/Youtube-Downloader-Extension/releases/latest) and download `chrunos-downloader.zip`.

2. **Unzip the file**
   Extract the zip to any folder on your computer, e.g. `~/Documents/chrunos-downloader/`. The folder will contain `manifest.json`, the `src/` directory, `logo/`, etc.

3. **Open the extensions page**
   In your browser, navigate to:
   - Chrome / Brave / Opera / Vivaldi: `chrome://extensions/`
   - Microsoft Edge: `edge://extensions/`

4. **Enable Developer mode**
   Toggle **Developer mode** on (top-right corner of the extensions page).

5. **Load the extension**
   Click **Load unpacked** and select the unzipped folder from step 2.

6. **Pin it (optional)**
   Click the puzzle icon in your toolbar and pin **Chrunos Downloader** for quick access.

> The extension icon will appear in your toolbar. You're ready to go.

### Updating

1. Download the new `chrunos-downloader.zip` from the [latest release](https://github.com/CodyChrunos/Youtube-Downloader-Extension/releases/latest).
2. Unzip it and replace the old folder (or load the new folder).
3. Your settings are preserved automatically.

## Usage

1. Navigate to any YouTube video or Shorts page.
2. Click the **Chrunos Downloader** icon in your toolbar.
3. The popup shows the video thumbnail, title, and channel.
4. Pick a **Video Quality** option (up to 4K/8K) or an **Audio Only** option (MP3 up to 320kbps).
5. Watch the progress bar — the file is fetched, muxed, and saved via your browser's download manager.

## FAQ

### How do I download a YouTube video in 4K?
Open the video on YouTube, click the extension icon, and select the highest quality available from the **Video Quality** list. If the uploader provided 4K (2160p) or 8K, it will be listed.

### Can I download YouTube Shorts?
Yes. Open the Shorts page, click the extension icon, and download as usual.

### How do I convert a video to MP3?
In the popup, choose any option under **Audio Only**. The extension extracts the audio track and saves it as a high-quality MP3 — no external tools required.

### Where are my downloads saved?
To your browser's default download folder. You can change this in your browser's download settings.

### Does it work on private or member-only videos?
Yes — if your YouTube account has access to the video while logged in, the extension can download it.

---

<p align="center">
  Made by Chrunos</a>
</p>
