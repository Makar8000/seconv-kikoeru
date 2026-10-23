# seconv-kikoeru
A wrapper for [SubtitleEdit](https://github.com/SubtitleEdit/subtitleedit)'s [SeConv CLI](https://subtitleedit.github.io/subtitleedit/reference/command-line.html) tool that lets you batch-translate various lyric files. Originally created for use with Kikoeru but adjusted to work with any folder structure.

## Usage
**Requirement:** `seconv` (from [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit/releases)). The app looks for it in `lib/seconv/` first, then in your PATH. If it isn't found, click **Download latest pre-release** in the app: it downloads the newest pre-release build for your OS/architecture (`SeConv-<OS>-<Arch>.zip` / `.tar.gz`) and extracts it to `lib/seconv/`. Both locations are relative to the folder you launch the app from (like `config.json`). Delete `lib/seconv/` to go back to the PATH version, or click the button again after deleting it to update.

1) Download the latest release from [here](https://github.com/Makar8000/seconv-kikoeru/releases/latest) and extract it.
2) Run `seconv-kikoeru`.
3) Adjust the settings in the window (see [Configuration](#configuration)) and click **Save config**.
4) Ensure the server for the translation engine specified in the config (ex. llama.cpp) is running
5) Place the files you want to translate in the queue folder (or set another folder in the app)
6) Click **Start translation**. Progress (by file count) and log output are shown in the window.

Files will be translated in-place. Backups will be placed in a `.trans-metadata/backups` subfolder within each RJ folder, mirroring that folder's structure. Metadata about translated/failed files is stored in `.trans-metadata/manifest.json` within each RJ folder; files that have already been successfully translated will be skipped on subsequent runs.

## Configuration
Settings are edited in the app and saved to `config.json` in the working directory. If it doesn't exist on launch, it is created from `src/config/default-config.json`. You can also edit `config.json` by hand.

### SeConv config
These are basic configurations sent to seconv. For more information on each option, please view their official documentation [here](https://subtitleedit.github.io/subtitleedit/reference/command-line.html)
- `translateEngine` - The engine to use for the translation. See official documentation for possible options. Defaults to `llamacpp`.
- `translateFrom` - The language to translate from. Defaults to auto-detect per file.
- `translateTo` - The language to translate to. Defaults to English.
- `engines` - Settings for each translation engine. Every engine has its own entry, so switching engines in the app never loses what you set for another one. Only the selected `translateEngine` is used when translating. Each entry has:
  - `model` - The model to use. If empty, it will use the first available model.
  - `url` - The url of the translation server. If provided, the server must already be running.
    - Tip: If you are using the `llamacpp` engine and you already have a working llama.cpp install, you can leave this empty and `seconv` will automatically start & stop a server for you.
  - `apiKey` - The API key for the translation service. Only used by `openai-compatible` and `deepl` (required for `deepl`). Stored in plain text in `config.json`.
  - `useCustomPrompt` - If `false`, `prompt` is kept but not sent, so seconv uses its own default prompt. Defaults to `true` for `llamacpp`, `ollama`, `lmstudio` and `openai-compatible`.
  - `prompt` - The translation prompt, or a path to a text file containing it. Only used by `llamacpp`, `ollama`, `lmstudio` and `openai-compatible`. `{0}` is the source language and `{1}` the target language. Keep it on one line. If empty, seconv's default prompt is used.
    - `llamacpp`, `ollama` and `lmstudio` default to a prompt for ASMR transcripts, written for general chat models.
    - `openai-compatible` defaults to the "style" prompt format that Tencent trained its default Hy-MT2 model on. If you switch it to a general chat model, copy the prompt from one of the other engines.
  - `additionalArgs` - For advanced use, a list of additional arguments to pass to the `seconv` process. See the official documentation for more information.

### seconv-kikoeru config
- `rjPath` - The folder that contains all of your lyric/subtitle files that need to be translated. Searched recursively. Defaults to `./queue`.
- `subtitleExtensions` - The file extensions to parse. Defaults to `lrc`, `srt`, `vtt`.

## Menu
- **Tools → Update seconv** - Downloads the latest pre-release of seconv into `lib/seconv/`.
- **Tools → Restore backups** - Restores every file in the `.trans-metadata/backups` subfolders under `rjPath` back to its original (pre-translation) content. Afterwards, each fully restored RJ folder's `.trans-metadata` folder is deleted.

Both are unavailable while a translation, download or restore is already running.

## Running from source
This project requires [deno](https://deno.com/) 2.9+ (uses `deno desktop` with the system WebView backend).

1) `deno install`
2) `deno task dev` (hot reload) or `deno task build` (outputs `bin/seconv-kikoeru/`)

### Tasks
- `deno task dev` - Runs the desktop app with hot module reload.
- `deno task build` - Builds the desktop app for the current platform.

On Linux, the WebView backend needs WebKitGTK.
