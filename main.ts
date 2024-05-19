import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  Editor,
  MarkdownView,
} from 'obsidian';
import { isExcluded } from './exclusions';

const stockIllegalSymbols = /[\\/:|#^[\]]/g;

interface LinePointer {
  lineNumber: number;
  text: string;
}

interface HeadingOverridesFilenamePluginSettings {
  userIllegalSymbols: string[];
  userIllegalSymbolsReplacement: string;
  ignoreRegex: string;
  ignoredFiles: { [key: string]: null };
  useAlphanumericOnly: boolean;
  useFileSaveHook: boolean;
}

const DEFAULT_SETTINGS: HeadingOverridesFilenamePluginSettings = {
  userIllegalSymbols: [],
  userIllegalSymbolsReplacement: '',
  ignoredFiles: {},
  ignoreRegex: '',
  useAlphanumericOnly: true,
  useFileSaveHook: true,
};

export default class HeadingOverridesFilenamePlugin extends Plugin {
  isRenameInProgress: boolean = false;
  settings: HeadingOverridesFilenamePluginSettings;

  async onload() {
    await this.loadSettings();

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (this.settings.useFileSaveHook) {
          return this.handleSyncHeadingToFile(file);
        }
      }),
    );

    // this.registerEvent(
    //   this.app.workspace.on('file-open', (file) => {
    //     if (this.settings.useFileOpenHook && file !== null) {
    //       return this.handleSyncHeadingToFile(file);
    //     }
    //   }),
    // );

    this.addSettingTab(new FilenameHeadingSyncSettingTab(this.app, this));

    this.addCommand({
      id: 'page-heading-sync-ignore-file',
      name: 'Ignore current file',
      checkCallback: (checking: boolean) => {
        let leaf = this.app.workspace.activeLeaf;
        if (leaf) {
          if (!checking) {
            this.settings.ignoredFiles[
              this.app.workspace.getActiveFile().path
            ] = null;
            this.saveSettings();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: 'sync-heading-to-filename',
      name: 'Sync Heading to Filename',
      editorCallback: (editor: Editor, view: MarkdownView) =>
        this.forceSyncHeadingToFilename(view.file),
    });
  }

  fileIsIgnored(activeFile: TFile, path: string): boolean {
    // check exclusions
    if (isExcluded(this.app, activeFile)) {
      return true;
    }

    // check manual ignore
    if (this.settings.ignoredFiles[path] !== undefined) {
      return true;
    }

    // check regex
    try {
      if (this.settings.ignoreRegex === '') {
        return;
      }

      const reg = new RegExp(this.settings.ignoreRegex);
      return reg.exec(path) !== null;
    } catch {}

    return false;
  }

  /**
   * Renames the file with the first heading found
   *
   * @param      {TAbstractFile}  file    The file
   */
  handleSyncHeadingToFile(file: TAbstractFile) {
    if (!(file instanceof TFile)) {
      return;
    }

    if (file.extension !== 'md') {
      // just bail
      return;
    }

    // if currently opened file is not the same as the one that fired the event, skip
    // this is to make sure other events don't trigger this plugin
    if (this.app.workspace.getActiveFile() !== file) {
      return;
    }

    // if ignored, just bail
    if (this.fileIsIgnored(file, file.path)) {
      return;
    }

    this.forceSyncHeadingToFilename(file);
  }

  forceSyncHeadingToFilename(file: TFile) {
    this.app.vault.read(file).then(async (data) => {
      const lines = data.split('\n');
      const start = this.findNoteStart(lines);
      const heading = this.findHeading(lines, start);

      if (heading === null) return; // no heading found, nothing to do here

      const sanitizedHeading = this.sanitizeHeading(heading.text);
      if (
        sanitizedHeading.length > 0 &&
        this.sanitizeHeading(file.basename) !== sanitizedHeading
      ) {
        const newPath = `${file.parent.path}/${sanitizedHeading}.md`;
        this.isRenameInProgress = true;
        await this.app.fileManager.renameFile(file, newPath);
        this.isRenameInProgress = false;
      }
    });
  }

  /**
   * Finds the start of the note file, excluding frontmatter
   *
   * @param {string[]} fileLines array of the file's contents, line by line
   * @returns {number} zero-based index of the starting line of the note
   */
  findNoteStart(fileLines: string[]) {
    // check for frontmatter by checking if first line is a divider ('---')
    if (fileLines[0] === '---') {
      // find end of frontmatter
      // if no end is found, then it isn't really frontmatter and function will end up returning 0
      for (let i = 1; i < fileLines.length; i++) {
        if (fileLines[i] === '---') {
          // end of frontmatter found, next line is start of note
          return i + 1;
        }
      }
    }
    return 0;
  }

  /**
   * Finds the first heading of the note file
   *
   * @param {string[]} fileLines array of the file's contents, line by line
   * @param {number} startLine zero-based index of the starting line of the note
   * @returns {LinePointer | null} LinePointer to heading or null if no heading found
   */
  findHeading(fileLines: string[], startLine: number): LinePointer | null {
    for (let i = startLine; i < fileLines.length; i++) {
      if (fileLines[i].startsWith('# ')) {
        return {
          lineNumber: i,
          text: fileLines[i].substring(2),
        };
      }
    }
    return null; // no heading found
  }

  regExpEscape(str: string): string {
    return String(str).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
  }

  sanitizeHeading(text: string) {
    // stockIllegalSymbols is a regExp object, but userIllegalSymbols is a list of strings and therefore they are handled separately.
    text = text.replace(stockIllegalSymbols, this.settings.userIllegalSymbolsReplacement);

    const userIllegalSymbolsReplacementEscaped = this.regExpEscape(this.settings.userIllegalSymbolsReplacement);

    if (this.settings.useAlphanumericOnly) {
      const AlphanumericOnlyRegExp = new RegExp(
        `[^a-zA-Z0-9${userIllegalSymbolsReplacementEscaped}]`,
        'g',
      );
      text = text.replace(AlphanumericOnlyRegExp, this.settings.userIllegalSymbolsReplacement);
    }

    // replace userIllegalSymbols with userIllegalSymbolsReplacement character
    const userIllegalSymbolsEscaped = this.settings.userIllegalSymbols.map(
      (str) => this.regExpEscape(str),
    );
    const userIllegalSymbolsRegExp = new RegExp(
      userIllegalSymbolsEscaped.join('|'),
      'g',
    );
    text = text.replace(userIllegalSymbolsRegExp, this.settings.userIllegalSymbolsReplacement);

    // replace consecutive userIllegalSymbolsReplacement characters with a single one
    const consecutiveUserIllegalSymbolsRegExp = new RegExp(
      `${userIllegalSymbolsReplacementEscaped}+`,
      'g',
    );
    text = text.replace(consecutiveUserIllegalSymbolsRegExp, this.settings.userIllegalSymbolsReplacement);

    return text.trim();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class FilenameHeadingSyncSettingTab extends PluginSettingTab {
  plugin: HeadingOverridesFilenamePlugin;
  app: App;

  constructor(app: App, plugin: HeadingOverridesFilenamePlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.app = app;
  }

  display(): void {
    let { containerEl } = this;
    let regexIgnoredFilesDiv: HTMLDivElement;

    const renderRegexIgnoredFiles = (div: HTMLElement) => {
      // empty existing div
      div.innerHTML = '';

      if (this.plugin.settings.ignoreRegex === '') {
        return;
      }

      try {
        const files = this.app.vault.getFiles();
        const reg = new RegExp(this.plugin.settings.ignoreRegex);

        files
          .filter((file) => reg.exec(file.path) !== null)
          .forEach((el) => {
            new Setting(div).setDesc(el.path);
          });
      } catch (e) {
        return;
      }
    };

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Heading Overrides Filename' });

    new Setting(containerEl)
      .setName('Use Alphanumeric characters only')
      .setDesc(
        'Wether the filename is restricted to alphanumeric characters only (+ the character replacement). Disable to allow any character.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useAlphanumericOnly)
          .onChange(async (value) => {
            this.plugin.settings.useAlphanumericOnly = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Custom Characters/Strings to be replaced')
      .setDesc(
        'Type characters/strings separated by a comma. This input is space sensitive.',
      )
      .addText((text) =>
        text
          .setPlaceholder('[],#,...')
          .setValue(this.plugin.settings.userIllegalSymbols.join())
          .onChange(async (value) => {
            this.plugin.settings.userIllegalSymbols = value.split(',');
            await this.plugin.saveSettings();
          }),
      );

      new Setting(containerEl)
      .setName('Character replacement')
      .setDesc(
        'Type character to replace unwanted strings. Leave empty to remove them.',
      )
      .addText((text) =>
        text
          .setPlaceholder('-')
          .setValue(this.plugin.settings.userIllegalSymbolsReplacement)
          .onChange(async (value) => {
            this.plugin.settings.userIllegalSymbolsReplacement = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Ignore Regex Rule')
      .setDesc(
        'Ignore rule in RegEx format. All files listed below will get ignored by this plugin.',
      )
      .addText((text) =>
        text
          .setPlaceholder('MyFolder/.*')
          .setValue(this.plugin.settings.ignoreRegex)
          .onChange(async (value) => {
            try {
              new RegExp(value);
              this.plugin.settings.ignoreRegex = value;
            } catch {
              this.plugin.settings.ignoreRegex = '';
            }

            await this.plugin.saveSettings();
            renderRegexIgnoredFiles(regexIgnoredFilesDiv);
          }),
      );

    new Setting(containerEl)
      .setName('Use File Save Hook')
      .setDesc(
        'Whether this plugin should trigger when a file is saved. Disable this when you want to trigger manually.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useFileSaveHook)
          .onChange(async (value) => {
            this.plugin.settings.useFileSaveHook = value;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h2', { text: 'Ignored Files By Regex' });
    containerEl.createEl('p', {
      text: 'All files matching the above RegEx will get listed here',
    });

    regexIgnoredFilesDiv = containerEl.createDiv('test');
    renderRegexIgnoredFiles(regexIgnoredFilesDiv);

    containerEl.createEl('h2', { text: 'Manually Ignored Files' });
    containerEl.createEl('p', {
      text:
        'You can ignore files from this plugin by using the "ignore this file" command',
    });

    // go over all ignored files and add them
    for (let key in this.plugin.settings.ignoredFiles) {
      const ignoredFilesSettingsObj = new Setting(containerEl).setDesc(key);

      ignoredFilesSettingsObj.addButton((button) => {
        button.setButtonText('Delete').onClick(async () => {
          delete this.plugin.settings.ignoredFiles[key];
          await this.plugin.saveSettings();
          this.display();
        });
      });
    }
  }
}
