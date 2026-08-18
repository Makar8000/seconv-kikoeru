# seconv-kikoeru
A wrapper for [SubtitleEdit](https://github.com/SubtitleEdit/subtitleedit)'s [SeConv CLI](https://subtitleedit.github.io/subtitleedit/reference/command-line.html) tool that lets you batch-translate various lyric files. Originally created for use with Kikoeru but adjusted to work with any folder structure.

## Usage
1) Download the latest release from [here](https://github.com/Makar8000/seconv-kikoeru/releases/latest) and extract it.
   - The correct file is named `seconv-kikoeru.zip`.
2) Open the `.env` file in notepad and adjust the settings as necessary.
   - See [Configuration](#configuration) for more details on the `.env` file
3) Save your changes and close the file
4) Ensure the server for the translation engine specified in the config (ex. llama.cpp) is running
5) Place the files you want to translate in the `queue` folder (or whatever folder you set in the `.env` file)
6) Run `translate.exe`

Files will be translated in-place. Backups will be placed in a `bak` subfolder

## Configuration
To adjust the configuration, you will need to create a `.env` file in the same directory by creating a copy of the `.env.example` file.

### SeConv config
These are basic configurations sent to seconv. For more information on each option, please view their official documentation [here](https://subtitleedit.github.io/subtitleedit/reference/command-line.html)
- `SECONV_PATH` - The path to the `seconv` executable. Leave this empty if you have SubtitleEdit installed or if `seconv` is already in your PATH.
- `TRANSLATE_ENGINE` - The engine to use for the translation. See official documentation for possible options. Defaults to `llamacpp`. The server must already be running prior to executing this application.
- `TRANSLATE_MODEL` - The model to use for the translation. If not provided, it will use the first available model.
- `TRANSLATE_URL` - The url of the translation server. If provided, the server must already be running prior to executing this application.
  - Tip: If you are using `llamacpp` engine and you already have a working llama.cpp install, you can leave this field empty and `seconv` will automatically start & stop a server for you.
- `TRANSLATE_FROM` - The language to translate from. Defaults to auto-detect per file.
- `TRANSLATE_TO` - The language to translate to. Defaults to English.
- `SECONV_ADDITIONAL_ARGS` - For advanced use, you can provide any additional arguments you'd like to pass to the `seconv` process here (comma-seperated). This can be useful if you want to use your own settings, profile, dictionary/replacements, system prompt, etc. See the official documentation for more information on the possible options.

### seconv-kikoeru config
- `RJ_PATH` - The location of the folder that contains all of your lyric/subtitle files that need to be translated. This path will be searched recursively. Defaults to `./queue` in the same directory if not provided.
- `ERRORS_FILE` - The location the json file where translation errors will be saved or loaded.
- `SUBTITLE_EXTENSIONS` - A comma-seperated list of file extensions to parse. Defaults to `lrc,srt,vtt`.

## Running from source
This project requires [deno](https://deno.com/) to run.

1) `deno install`
2) Copy `.env.example` to `.env`
3) Edit `.env` and adjust settings as necessary.
   - See [Configuration](#configuration) for more details on the `.env` file
4) Place your files/folders with untranslated subtitles in your `RJ_PATH` (queue) folder
5) `deno task translate`

### Tasks
- `deno task translate` - The main task. Translates lyrics/subtitles as specified in this README.
- `deno task restore-backups` - (Coming Soon) will restore any files in the `bak` subfolders. Afterwards, the backups will be deleted.