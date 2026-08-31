/**
 * A stand-in for the VS Code API, faithful where it is being tested.
 *
 * The extension cannot run outside an extension host, which for a package this
 * size means three thousand lines nothing can check. This closes most of that
 * gap: it is a real implementation of the parts activation touches — command
 * registration, context keys, settings, providers, the tree view — recording
 * what it is asked to do, so a test can then ask what happened.
 *
 * Copied into node_modules/vscode by the test setup, because `vscode` is a
 * bare specifier and that is where Node will look for it.
 *
 * What it does NOT do is behave like the editor. A test here can say "this
 * command is registered" and "this setting is read with that default". It
 * cannot say "the menu appears" — only a real host can.
 */

'use strict';

const recorder = {
  commands: new Map(),
  executed: [],
  context: new Map(),
  configReads: [],
  providers: [],
  views: [],
  disposables: 0,
  warnings: [],
  messages: [],
  reset() {
    this.commands.clear();
    this.executed.length = 0;
    this.context.clear();
    this.configReads.length = 0;
    this.providers.length = 0;
    this.views.length = 0;
    this.disposables = 0;
    this.warnings.length = 0;
    this.messages.length = 0;
    workspaceState.workspaceFolders = undefined;
    workspaceState.settings = {};
    workspaceState.documents = [];
    workspaceState.isTrusted = true;
  },
};

const workspaceState = { workspaceFolders: undefined, settings: {}, documents: [], isTrusted: true };

const disposable = (onDispose) => ({
  dispose() {
    recorder.disposables += 1;
    if (typeof onDispose === 'function') onDispose();
  },
});

// ------------------------------------------------------------------------- //
// Values
// ------------------------------------------------------------------------- //

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, '/');
    this.scheme = 'file';
  }
  static file(fsPath) {
    return new Uri(fsPath);
  }
  static parse(value) {
    return new Uri(String(value));
  }
  static joinPath(base, ...parts) {
    const joined = [base.fsPath, ...parts].join('/').replace(/\/+/g, '/');
    // `..` is resolved the way the real one does, so a test can compare paths.
    const stack = [];
    for (const segment of joined.split('/')) {
      if (segment === '..') stack.pop();
      else if (segment !== '.') stack.push(segment);
    }
    return new Uri(stack.join('/'));
  }
  toString() {
    return `file://${this.path}`;
  }
  with() {
    return this;
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, startCharacter, end, endCharacter) {
    if (typeof start === 'number') {
      this.start = new Position(start, startCharacter);
      this.end = new Position(end, endCharacter);
    } else {
      this.start = start;
      this.end = startCharacter;
    }
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return disposable();
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {}
}

class Simple {
  constructor(...args) {
    this.args = args;
    const [first] = args;
    if (typeof first === 'string') this.value = first;
  }
}

class TreeItem extends Simple {
  constructor(label, collapsibleState) {
    super(label, collapsibleState);
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value;
    this.isTrusted = false;
    this.supportThemeIcons = false;
  }
  appendMarkdown(more) {
    this.value += more;
    return this;
  }
  appendText(more) {
    this.value += more;
    return this;
  }
  appendCodeblock(code, language = '') {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }
  replace(uri, range, text) {
    this.edits.push({ kind: 'replace', uri, range, text });
  }
  insert(uri, position, text) {
    this.edits.push({ kind: 'insert', uri, position, text });
  }
  delete(uri, range) {
    this.edits.push({ kind: 'delete', uri, range });
  }
}

const CodeActionKind = {
  QuickFix: { value: 'quickfix' },
  Refactor: { value: 'refactor' },
  Source: { value: 'source' },
};

// ------------------------------------------------------------------------- //
// Namespaces
// ------------------------------------------------------------------------- //

const commands = {
  registerCommand(id, handler) {
    if (recorder.commands.has(id)) recorder.warnings.push(`${id} registered twice`);
    recorder.commands.set(id, handler);
    return disposable(() => recorder.commands.delete(id));
  },
  registerTextEditorCommand(id, handler) {
    return commands.registerCommand(id, handler);
  },
  async executeCommand(name, ...args) {
    recorder.executed.push({ name, args });
    if (name === 'setContext') recorder.context.set(args[0], args[1]);
    return undefined;
  },
  async getCommands() {
    return [...recorder.commands.keys()];
  },
};

const workspace = {
  onDidCloseTextDocument() {
    return disposable();
  },
  onDidOpenTextDocument() {
    return disposable();
  },
  get workspaceFolders() {
    return workspaceState.workspaceFolders;
  },
  get textDocuments() {
    return workspaceState.documents;
  },
  get name() {
    return workspaceState.workspaceFolders?.[0]?.name;
  },
  // Workspace trust. Defaults to trusted so the existing tests keep exercising
  // the ordinary path; the trust tests set it to false.
  get isTrusted() {
    return workspaceState.isTrusted;
  },
  onDidGrantWorkspaceTrust() {
    return disposable();
  },
  getConfiguration(section) {
    return {
      get(key, fallback) {
        recorder.configReads.push({ section, key, fallback });
        const value = workspaceState.settings[`${section}.${key}`];
        return value === undefined ? fallback : value;
      },
      async update() {},
      has() {
        return true;
      },
    };
  },
  onDidChangeConfiguration() {
    return disposable();
  },
  onDidSaveTextDocument() {
    return disposable();
  },
  onDidChangeTextDocument() {
    return disposable();
  },
  createFileSystemWatcher(pattern) {
    recorder.providers.push({ kind: 'watcher', pattern: String(pattern) });
    return {
      onDidCreate: () => disposable(),
      onDidChange: () => disposable(),
      onDidDelete: () => disposable(),
      dispose() {},
    };
  },
  async findFiles() {
    return [];
  },
  asRelativePath(target) {
    return typeof target === 'string' ? target : (target?.fsPath ?? String(target));
  },
  getWorkspaceFolder() {
    return workspaceState.workspaceFolders?.[0];
  },
  fs: {
    async stat() {
      throw new Error('ENOENT');
    },
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
    async createDirectory() {},
    async readDirectory() {
      return [];
    },
    async delete() {},
  },
  async openTextDocument(target) {
    return { uri: target, getText: () => '', lineCount: 0, languageId: 'plotexcel-layout' };
  },
  async applyEdit() {
    return true;
  },
};

const window = {
  createOutputChannel(name) {
    recorder.providers.push({ kind: 'output', name });
    return {
      name,
      appendLine() {},
      append() {},
      show() {},
      dispose() {},
      info() {},
      warn() {},
      error() {},
      debug() {},
      trace() {},
    };
  },
  createStatusBarItem() {
    return { text: '', tooltip: '', command: undefined, show() {}, hide() {}, dispose() {} };
  },
  registerTreeDataProvider(id, provider) {
    recorder.views.push({ id, provider });
    return disposable();
  },
  createTreeView(id, options) {
    recorder.views.push({ id, provider: options?.treeDataProvider });
    return { dispose() {}, reveal() {} };
  },
  createWebviewPanel() {
    return {
      webview: { html: '', onDidReceiveMessage: () => disposable(), postMessage: async () => true, asWebviewUri: (u) => u, cspSource: '' },
      onDidDispose: () => disposable(),
      reveal() {},
      dispose() {},
    };
  },
  async showInformationMessage() {
    return undefined;
  },
  // Recorded so a test can assert what the person was told. Answering
  // undefined is the "dismissed the notification" case.
  async showWarningMessage(message) {
    recorder.messages.push({ kind: 'warning', message: String(message) });
    return undefined;
  },
  async showErrorMessage() {
    return undefined;
  },
  async showQuickPick() {
    return undefined;
  },
  async showInputBox() {
    return undefined;
  },
  async showOpenDialog() {
    return undefined;
  },
  async showSaveDialog() {
    return undefined;
  },
  async showWorkspaceFolderPick() {
    return undefined;
  },
  async showTextDocument(target) {
    return { document: { uri: target, getText: () => '' }, edit: async () => true, selection: undefined };
  },
  withProgress(_options, task) {
    return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable() });
  },
  get activeTextEditor() {
    return undefined;
  },
  onDidChangeActiveTextEditor() {
    return disposable();
  },
  registerFileDecorationProvider() {
    return disposable();
  },
};

const languages = {
  createDiagnosticCollection(name) {
    recorder.providers.push({ kind: 'diagnostics', name });
    return { set() {}, delete() {}, clear() {}, dispose() {} };
  },
  registerCompletionItemProvider(selector, provider, ...triggers) {
    recorder.providers.push({ kind: 'completion', selector, provider, triggers });
    return disposable();
  },
  registerHoverProvider(selector, provider) {
    recorder.providers.push({ kind: 'hover', selector, provider });
    return disposable();
  },
  registerCodeLensProvider(selector, provider) {
    recorder.providers.push({ kind: 'codelens', selector, provider });
    return disposable();
  },
  registerCodeActionsProvider(selector, provider, meta) {
    recorder.providers.push({ kind: 'codeactions', selector, provider, meta });
    return disposable();
  },
  registerDocumentFormattingEditProvider(selector, provider) {
    recorder.providers.push({ kind: 'formatting', selector, provider });
    return disposable();
  },
  registerDocumentDropEditProvider(selector, provider) {
    recorder.providers.push({ kind: 'drop', selector, provider });
    return disposable();
  },
};

// ------------------------------------------------------------------------- //
// Exports
// ------------------------------------------------------------------------- //
//
// Written out one at a time rather than as `module.exports = {...}` or a
// Proxy, because the extension does `import * as vscode from 'vscode'` and
// Node builds that namespace by statically scanning this file for export
// assignments. A Proxy is invisible to that scan, and every property comes
// back undefined — which looks exactly like the extension being broken.
//
// The consequence is that anything not listed here is `undefined` rather than
// a forgiving stand-in. That is deliberate: coverage.test.ts reads the
// extension sources and fails naming whatever is missing, so the gap is
// reported as a gap rather than found later as a strange TypeError.

exports.Uri = Uri;
exports.Position = Position;
exports.Range = Range;
exports.Selection = Range;
exports.EventEmitter = EventEmitter;
exports.TreeItem = TreeItem;
exports.MarkdownString = MarkdownString;
exports.Diagnostic = Diagnostic;
exports.CodeAction = CodeAction;
exports.CodeActionKind = CodeActionKind;
exports.CompletionItem = CompletionItem;
exports.CodeLens = CodeLens;
exports.WorkspaceEdit = WorkspaceEdit;
exports.TextEdit = {
  replace: (range, text) => ({ range, newText: text }),
  insert: (at, text) => ({ at, newText: text }),
  delete: (range) => ({ range, newText: '' }),
};
exports.SnippetString = Simple;
exports.RelativePattern = Simple;
exports.ThemeIcon = Simple;
exports.ThemeColor = Simple;
exports.Hover = Simple;
exports.Location = Simple;
exports.DocumentDropEdit = Simple;
exports.DataTransfer = Simple;
exports.CancellationTokenSource = Simple;
exports.Disposable = Object.assign(Simple, {
  from: (...items) => disposable(() => items.forEach((item) => item?.dispose?.())),
});

exports.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
exports.StatusBarAlignment = { Left: 1, Right: 2 };
exports.ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
exports.ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
exports.FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
exports.DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
exports.CompletionItemKind = {
  Text: 0, Method: 1, Function: 2, Field: 4, Property: 9, Value: 11,
  Enum: 12, Keyword: 13, File: 16, Folder: 18, Constant: 20,
};
exports.ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
exports.EndOfLine = { LF: 1, CRLF: 2 };
exports.UIKind = { Desktop: 1, Web: 2 };
exports.ExtensionMode = { Production: 1, Development: 2, Test: 3 };

exports.commands = commands;
exports.workspace = workspace;
exports.window = window;
exports.languages = languages;
exports.env = {
  openExternal: async () => true,
  clipboard: { writeText: async () => {}, readText: async () => '' },
  uiKind: 1,
  appName: 'stub',
};
exports.extensions = { getExtension: () => undefined, all: [] };

// The test's way in.
exports.__recorder = recorder;
exports.__state = workspaceState;
