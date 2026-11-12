# VersePlayground

[English](README.md) | 日本語

Unreal Engine 6 の Verse を、UEFN やエンジンのフルビルドなしに試すための環境です。

`Setup.bat` を実行すると、Unreal Engine のリポジトリから Verse の実行に必要な部分だけを取得し、
Verse のコマンドラインツール `verse.exe` をビルドします。あとは `.verse` ファイルを 1 つ書けば、その場で実行して動作を確かめられます。

このリポジトリには Epic Games のコードもバイナリも含まれていません。
エンジンのソースは、Setup が利用者自身のアクセス権で Epic Games の GitHub リポジトリから取得します。

## 必要なもの

| 項目 | 内容 |
|---|---|
| Unreal Engine のソースへのアクセス権 | GitHub アカウントを Epic Games アカウントに連携し、`EpicGames/UnrealEngine` を見られる状態にしておく（[手順](https://www.unrealengine.com/ue-on-github)） |
| Git for Windows | 2.27 以降 |
| Visual Studio | Visual Studio 2026 または Visual Studio 2026 Build Tools と、エンジンが求める MSVC ツールチェーン（現在のバージョンでは v14.50 の 14.50.35723 以降）。コンパイルにはエンジン同梱の Clang を使い、MSVC はライブラリとして使う。それより古い Visual Studio はビルドに使われない。無ければ Setup が Visual Studio Installer での追加を提案する |
| Windows SDK | エンジンが求める版（現在のバージョンでは 10.0.26100.0 以降）。無ければ Setup が Visual Studio Installer での追加を提案する |
| ディスク | 約 10 GB（取得・展開したファイル約 5 GB、ビルドの中間ファイル約 2.5 GB、ダウンロードのキャッシュ約 1 GB） |
| メモリ | 16 GB 以上を推奨。並列コンパイル数はメモリ量から自動で決める |

取得するデータは、git が約 230 MB、バイナリ依存が約 1 GB です（エンジンを丸ごと取得すると数十 GB になります）。

## 使い方

1. このリポジトリを clone する。
2. `Setup.bat` をダブルクリックする。
3. バージョンを選ぶ。Enter で、動作確認済みの最新版が選ばれる。
   そのバージョンが必要とする Windows SDK や MSVC ツールチェーンが無い場合は、ダウンロードの前に知らせ、インストールするかを尋ねる。
   Visual Studio 2026 があればそこへ追加し、無ければ既存の Visual Studio とは別に Visual Studio 2026 Build Tools を入れる。
   インストール時は管理者権限を求められ、Visual Studio は閉じておく必要がある。
   `-InstallBuildTools Yes` / `-InstallBuildTools No` を付けると質問せずに決める。
4. 初回は GitHub へのサインインを求められるので、Unreal Engine のリポジトリにアクセスできるアカウントでサインインする。
5. 取得とビルドが終わると、`Samples/HelloWorld/HelloWorld.verse` が実行されて `Hello, World!` と表示される。
6. VS Code が入っていれば、Verse Playground 拡張を入れるかを尋ねられる（[VS Code](#vs-code) を参照）。
   `-InstallExtension Yes` / `-InstallExtension No` を付けると質問せずに決める。

エンジンは既定で `UnrealEngine/` に置かれます。別の場所にするときは `-InstallDir` を指定します。

```bat
Setup.bat -InstallDir D:\VerseEngine
```

もう一度 `Setup.bat` を実行すると、同じフォルダを選んだバージョンに切り替えてビルドし直します。

## Verse を実行する

```bat
UnrealEngine\Engine\Binaries\Win64\verse.exe Samples\HelloWorld\HelloWorld.verse
UnrealEngine\Engine\Binaries\Win64\verse.exe Samples\HelloWorld\HelloWorld.verse Verse
```

`verse.exe` はファイル内の `Main` を呼び出します。スクリプトのパスより後ろの引数は `Args` に渡されます。

```verse
Main(Args:[]string, Env:[string]string)<suspends>:void =
    Print("Hello, World!")
```

コンパイルエラーは `ファイル(行,列,行,列): Verse compiler error V3506: ...` の形式で表示されます。

### サンプル

サンプルは 1 フォルダに 1 プログラムずつ入っています。自分のコードも 1 フォルダ 1 プログラムにしてください。
VS Code の言語サーバーはフォルダ内のファイルをまとめてチェックするため、同じフォルダに `Main` が 2 つあると衝突します。

| ファイル | 内容 |
|---|---|
| `Samples/HelloWorld/HelloWorld.verse` | 最小のプログラムと、コマンドライン引数の受け取り |
| `Samples/FailureContext/FailureContext.verse` | 失敗しうる式と Failure Context、`<decides>` の関数 |
| `Samples/Concurrency/Concurrency.verse` | `race` と `sync` による構造化並行処理 |
| `Samples/Modules/Modules.verse` | モジュール、アクセス指定子、抽象クラスと継承、エフェクト |

### 使える機能と制限

- 使えるのは `/Verse.org/Verse` の標準ライブラリと、`verse.exe` が用意する入出力の関数です。
  - `Print`、`InputLine`（標準入力）、`LoadTextFile` / `SaveTextFile`、`Yield`、`Exit`
- Fortnite や UEFN の API（`/Fortnite.com/...` や `Sleep` など）はありません。UEFN のチュートリアルのコードは、そのままでは動かないことがあります。
- `verse.exe` には別のフォルダのモジュールを読み込むオプション `--mount` がありますが、まだ実装されていません。モジュールは `Main` と同じファイルの中に定義します。

## VS Code

`Extension/verse-playground.vsix` は、この環境用の VS Code 拡張です。Setup が導入を尋ねるほか、VS Code の
「Extensions: Install from VSIX...」から自分で入れることもできます。このリポジトリのフォルダ（またはその下のフォルダ）を
開けば、拡張が `verse.exe` を自動で見つけます。

| 機能 | 内容 |
|---|---|
| 実行 | エディタ右上の ▶ ボタンで、開いているファイルをターミナルで実行する（`InputLine` も使える）。「Verse: Run Verse File with Arguments...」で引数を渡せる |
| デバッグ | その隣のボタンか F5。ブレークポイント、ステップオーバー / イン / アウト、コールスタックとローカル変数 |
| 構文ハイライト | 拡張の初回起動時に、自分のエンジンのチェックアウトからコピーする。ウィンドウの再読み込みを求められたら従う |
| エラー表示 | 実行したときのコンパイルエラーを Problems パネルに表示する |
| 入力中のエラー、ホバー、定義へ移動、補完 | Verse の言語サーバーが必要（下記） |

言語サーバーは、このリポジトリにも Unreal Engine のソースにも含まれていません。UEFN が VS Code に入れる Verse 拡張
（`epicgames.verse`。VS Code Marketplace には公開されていない）に同梱されています。UEFN を入れていれば、Verse Playground は
そのサーバーを、自分のエンジンのチェックアウトの Verse で動かします。このとき UEFN の Verse 拡張はワークスペースで無効に
してください。有効なままだとサーバーが 2 つ動き、すべてのエラーが 2 回表示されます（有効なときは Verse Playground が知らせます）。
UEFN が無くても、表のそれ以外の機能は使えます。

## バージョンの管理

`Versions/` には、エンジンのコミットごとに、取得するディレクトリの一覧とバイナリ依存の一覧が入っています。

| ファイル | 内容 |
|---|---|
| `sparse-paths.txt` | git の sparse checkout で取得するディレクトリ |
| `gitdepsignore.txt` | エンジンの `GitDependencies` が取得するバイナリ依存のホワイトリスト。Setup が `.gitdepsignore` としてコピーする |
| `version.json` | コミット、確認したかどうか、ダウンロード量の見積もり、エンジンが必要とする Windows SDK と MSVC ツールチェーン |

Setup は確認済み（`"verified": true`）のバージョンを既定にします。確認していないバージョンを選ぶと警告を表示します。
`-Version` にフォルダ名かコミットの先頭部分を渡すと、質問せずにそのバージョンを使います。

### 新しいエンジンのコミットを追加する（メンテナー向け）

1. エンジンをフルで clone し、エンジンの `Setup.bat` を実行しておく。
2. 一覧を生成する。

   ```powershell
   .\Tools\New-VersionManifest.ps1 -EngineDir 'D:\UnrealEngine'
   ```

   UnrealBuildTool で `VerseCmd` ターゲットのモジュール依存を書き出し、`Tools/ManifestRules.psd1` のルールを足して
   `Versions/<ブランチ>-<コミット>/` を作ります。
3. 空のフォルダに Setup して確かめる。

   ```bat
   Setup.bat -Version <フォルダ名> -InstallDir D:\VerseVerify
   ```

4. ビルドとサンプルの実行が通ったら、`version.json` の `verified` を `true`、`verifiedDate` を確認した日付にする。

モジュール依存だけでは足りないファイル（UnrealBuildTool が直接読むもの、同梱のコンパイラなど）は
`Tools/ManifestRules.psd1` に理由と一緒に書いてあります。新しいコミットでビルドが失敗したら、まずここへの追加が必要かを調べます。

### VS Code 拡張をビルドする（メンテナー向け）

拡張のソースは `Extension/` にあります。ビルドには Node.js 22.18 以降が必要です。

```bat
cd Extension
npm ci
npm run package
```

型チェックとテストを実行し、`Extension/verse-playground.vsix` を書き出します。`Extension/package.json` の `version` を
上げ、新しい `.vsix` をコミットします。利用者は Node.js なしで使え、どのビルドが入っているかも見分けられます。

パッケージにせずに変更を試すときは、VS Code で `Extension` フォルダを開いて F5（「Run Extension」）を押します。
拡張をビルドし、インストール済みのものではなくソースの拡張を読み込んだ別ウィンドウ（Extension Development Host）で
リポジトリのルートを開きます。`Extension/src` に置いたブレークポイントで止まります。単体テストだけなら `Extension` で
`npm test` を実行します。

## ライセンス

このリポジトリのスクリプト、ツール、VS Code 拡張は [MIT License](LICENSE) で公開しています。

`Samples/` のプログラムは学習用です。表記を残す必要もなく、自由にコピー・改変・再利用できます。

Setup が取得する Unreal Engine のソースとバイナリは、このリポジトリには含まれません。アクセス権を得るときに同意した
Unreal Engine EULA が引き続き適用されます。
