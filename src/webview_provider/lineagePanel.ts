import { readFileSync } from "fs";
import * as path from "path";
import {
  CancellationToken,
  ColorThemeKind,
  commands,
  Disposable,
  ProgressLocation,
  TextEditor,
  Uri,
  Webview,
  WebviewOptions,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  window,
  workspace,
} from "vscode";
import { provideSingleton } from "../utils";
import { TelemetryService } from "../telemetry";
import { DBTProjectContainer } from "../manifest/dbtProjectContainer";
import {
  ManifestCacheChangedEvent,
  ManifestCacheProjectAddedEvent,
} from "../manifest/event/manifestCacheChangedEvent";
import { GraphMetaMap } from "../domain";

type Table = {
  table: string;
  url: string;
  count: number;
  label: string;
};

@provideSingleton(LineagePanel)
export class LineagePanel implements WebviewViewProvider {
  public static readonly viewType = "dbtPowerUser.LineageView";

  private _disposables: Disposable[] = [];
  private _panel: WebviewView | undefined;
  private eventMap: Map<string, ManifestCacheProjectAddedEvent> = new Map();

  public constructor(
    private dbtProjectContainer: DBTProjectContainer,
    private telemetry: TelemetryService,
  ) {
    dbtProjectContainer.onManifestChanged((event) => {
      this.onManifestCacheChanged(event);
    });

    window.onDidChangeActiveTextEditor((event: TextEditor | undefined) => {
      if (event === undefined) {
        return;
      }
      if (!this._panel) {
        return;
      }
      this.renderStartingNode();
    });
  }

  private onManifestCacheChanged(event: ManifestCacheChangedEvent): void {
    event.added?.forEach((added) => {
      this.eventMap.set(added.projectRoot.fsPath, added);
    });
    event.removed?.forEach((removed) => {
      this.eventMap.delete(removed.projectRoot.fsPath);
    });
    this.renderStartingNode();
  }

  private renderStartingNode() {
    if (!this._panel) {
      return;
    }
    this._panel.webview.postMessage({
      command: "render",
      args: this.getStartingNode(),
    });
  }

  resolveWebviewView(
    panel: WebviewView,
    context: WebviewViewResolveContext<unknown>,
    _token: CancellationToken,
  ): void | Thenable<void> {
    this._panel = panel;
    this.setupWebviewOptions(context);
    this.renderWebviewView(context);
    this.setupWebviewHooks(context);
  }

  private handleRequest(args: { url: string; id: number; params: unknown }) {
    let body;
    if (args.url === "upstreamTables") {
      body = {
        tables: this.getUpstreamTables(args.params as { table: string }),
      };
    }
    if (args.url === "downstreamTables") {
      body = {
        tables: this.getDownstreamTables(args.params as { table: string }),
      };
    }
    this._panel?.webview.postMessage({
      command: "response",
      args: {
        id: args.id,
        body,
        status: true,
      },
    });
  }

  private getConnectedTables(
    key: keyof GraphMetaMap,
    table: string,
  ): Table[] | undefined {
    const graphMetaMap = this.getGraphMetaMap();
    if (!graphMetaMap) {
      return;
    }
    const dependencyNodes: Map<string, { nodes: any[] }> = graphMetaMap[key];
    const node = dependencyNodes.get(table);
    if (!node) {
      return;
    }
    const tables: Map<string, Table> = new Map();
    const addToTables = (key: string, value: Omit<Table, "table">) => {
      if (!tables.has(key)) {
        tables.set(key, { ...value, table: key });
      }
    };
    node.nodes.forEach(
      (child: { key: "string"; url: "string"; label: "string" }) => {
        const count = dependencyNodes.get(child.key)?.nodes.length || 0;
        addToTables(child.key, {
          url: child.url,
          count,
          label: child.label,
        });
      },
    );
    return Array.from(tables.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }

  private getUpstreamTables({ table }: { table: string }) {
    return this.getConnectedTables("children", table);
  }

  private getDownstreamTables({ table }: { table: string }) {
    return this.getConnectedTables("parents", table);
  }

  private setupWebviewHooks(context: WebviewViewResolveContext) {
    this._panel!.webview.onDidReceiveMessage(
      async (message) => {
        console.log("onDidReceiveMessage -> ", message);
        switch (message.command) {
          case "openFile":
            const { url } = message;
            if (!url) {
              return;
            }
            await commands.executeCommand("vscode.open", Uri.file(url), {
              preview: false,
              preserveFocus: true,
            });
            break;
          case "request":
            this.handleRequest(message.args);
            break;
        }
      },
      null,
      this._disposables,
    );
  }

  private getGraphMetaMap(): GraphMetaMap | undefined {
    if (window.activeTextEditor === undefined || this.eventMap === undefined) {
      return;
    }

    const currentFilePath = window.activeTextEditor.document.uri;
    const projectRootpath =
      this.dbtProjectContainer.getProjectRootpath(currentFilePath);
    if (projectRootpath === undefined) {
      return;
    }

    const event = this.eventMap.get(projectRootpath.fsPath);
    if (event === undefined) {
      return;
    }

    return event.graphMetaMap;
  }

  private getStartingNode() {
    const graphMetaMap = this.getGraphMetaMap();
    if (!graphMetaMap) {
      return;
    }
    const fileName = path.basename(
      window.activeTextEditor!.document.fileName,
      ".sql",
    );
    const dependencyNodes = graphMetaMap["parents"];
    const key = Array.from(dependencyNodes.keys()).find(
      (k) => k.endsWith(`.${fileName}`) && k.startsWith("model."),
    );
    if (!key) {
      return;
    }
    const downstreamCount = dependencyNodes.get(key)?.nodes.length || 0;
    const upstreamCount = graphMetaMap["children"].get(key)?.nodes.length || 0;
    return {
      node: {
        table: key,
        url: window.activeTextEditor!.document.uri.path,
        upstreamCount,
        downstreamCount,
      },
    };
  }

  private setupWebviewOptions(context: WebviewViewResolveContext) {
    this._panel!.title = "Lineage";
    this._panel!.description =
      "Show table level and column level lineage SQL queries";
    this._panel!.webview.options = <WebviewOptions>{ enableScripts: true };
  }

  private renderWebviewView(context: WebviewViewResolveContext) {
    const webview = this._panel!.webview!;
    this._panel!.webview.html = getHtml(
      webview,
      this.dbtProjectContainer.extensionUri,
    );
  }
}

/** Gets webview HTML */
function getHtml(webview: Webview, extensionUri: Uri) {
  const indexPath = getUri(webview, extensionUri, [
    "new_lineage_panel",
    "dist",
    "index.html",
  ]);
  const resourceDir = getUri(webview, extensionUri, [
    "new_lineage_panel",
    "dist",
  ]);
  return readFileSync(indexPath.fsPath)
    .toString()
    .replace(/\/__ROOT__/g, resourceDir.toString())
    .replace(/__ROOT__/g, resourceDir.toString())
    .replace(/__NONCE__/g, getNonce())
    .replace(/__CSPSOURCE__/g, webview.cspSource);
}

/** Used to enforce a secure CSP */
function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/** Utility method for generating webview Uris for resources */
function getUri(webview: Webview, extensionUri: Uri, pathList: string[]) {
  return webview.asWebviewUri(Uri.joinPath(extensionUri, ...pathList));
}
