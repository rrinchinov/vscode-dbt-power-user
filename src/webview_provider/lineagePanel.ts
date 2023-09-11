import { readFileSync } from "fs";
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

@provideSingleton(LineagePanel)
export class LineagePanel implements WebviewViewProvider {
  public static readonly viewType = "dbtPowerUser.LineageView";

  private _disposables: Disposable[] = [];
  private _panel: WebviewView | undefined;

  public constructor(
    private dbtProjectContainer: DBTProjectContainer,
    private telemetry: TelemetryService,
  ) {
    // dbtProjectContainer.onManifestChanged((event) =>
    //   this.onManifestCacheChanged(event)
    // );
    window.onDidChangeActiveColorTheme(
      async (e) => {
        if (this._panel) {
          //   this.updateGraphStyle();
        }
      },
      null,
      this._disposables,
    );
    window.onDidChangeActiveTextEditor((event: TextEditor | undefined) => {
      if (event === undefined) {
        return;
      }
      //   this.g6Data = this.parseGraphData();
      //   if (this._panel) {
      //     this.transmitData(this.g6Data);
      //     this.updateGraphStyle();
      //   }
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

  private setupWebviewHooks(context: WebviewViewResolveContext) {
    this._panel!.webview.onDidReceiveMessage(
      async (message) => {
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
        }
      },
      null,
      this._disposables,
    );
    // const sendLineageViewEvent = () => {
    //   if (this._panel!.visible) {
    //     this.telemetry.sendTelemetryEvent("LineagePanelActive");
    //   }
    // };
    // sendLineageViewEvent();
    // this._panel!.onDidChangeVisibility(sendLineageViewEvent);
  }

  private setupWebviewOptions(context: WebviewViewResolveContext) {
    this._panel!.title = "Lineage(Beta)";
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
  const resourceDir = getUri(webview, extensionUri, ["new_lineage_panel"]);
  // const theme = [
  //   ColorThemeKind.Light,
  //   ColorThemeKind.HighContrastLight,
  // ].includes(window.activeColorTheme.kind)
  //   ? "light"
  //   : "dark";
  return (
    readFileSync(indexPath.fsPath)
      .toString()
      .replace(/__ROOT__/g, resourceDir.toString())
      //   .replace(/__THEME__/g, theme)
      .replace(/__NONCE__/g, getNonce())
      .replace(/__CSPSOURCE__/g, webview.cspSource)
  );
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
