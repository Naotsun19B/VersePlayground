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
| Visual Studio | 「C++ によるデスクトップ開発」ワークロードと Windows 10/11 SDK。コンパイラはエンジンに同梱のものが使われる |
| ディスク | 約 10 GB（取得・展開したファイル約 5 GB、ビルドの中間ファイル約 2.5 GB、ダウンロードのキャッシュ約 1 GB） |
| メモリ | 16 GB 以上を推奨。並列コンパイル数はメモリ量から自動で決める |

取得するデータは、git が約 230 MB、バイナリ依存が約 1 GB です（エンジンを丸ごと取得すると数十 GB になります）。

## 使い方

1. このリポジトリを clone する。
2. `Setup.bat` をダブルクリックする。
3. バージョンを選ぶ。Enter で、動作確認済みの最新版が選ばれる。
4. 初回は GitHub へのサインインを求められるので、Unreal Engine のリポジトリにアクセスできるアカウントでサインインする。
5. 取得とビルドが終わると、`Samples/HelloWorld.verse` が実行されて `Hello, World!` と表示される。

エンジンは既定で `UnrealEngine/` に置かれます。別の場所にするときは `-InstallDir` を指定します。

```bat
Setup.bat -InstallDir D:\VerseEngine
```

もう一度 `Setup.bat` を実行すると、同じフォルダを選んだバージョンに切り替えてビルドし直します。

## Verse を実行する

```bat
UnrealEngine\Engine\Binaries\Win64\verse.exe Samples\HelloWorld.verse
UnrealEngine\Engine\Binaries\Win64\verse.exe Samples\HelloWorld.verse Verse
```

`verse.exe` はファイル内の `Main` を呼び出します。スクリプトのパスより後ろの引数は `Args` に渡されます。

```verse
Main(Args:[]string, Env:[string]string)<suspends>:void =
    Print("Hello, World!")
```

コンパイルエラーは `ファイル(行,列,行,列): Verse compiler error V3506: ...` の形式で表示されます。

### サンプル

| ファイル | 内容 |
|---|---|
| `Samples/HelloWorld.verse` | 最小のプログラムと、コマンドライン引数の受け取り |
| `Samples/FailureContext.verse` | 失敗しうる式と Failure Context、`<decides>` の関数 |
| `Samples/Concurrency.verse` | `race` と `sync` による構造化並行処理 |
| `Samples/Modules.verse` | モジュール、アクセス指定子、抽象クラスと継承、エフェクト |

### 使える機能と制限

- 使えるのは `/Verse.org/Verse` の標準ライブラリと、`verse.exe` が用意する入出力の関数です。
  - `Print`、`InputLine`（標準入力）、`LoadTextFile` / `SaveTextFile`、`Yield`、`Exit`
- Fortnite や UEFN の API（`/Fortnite.com/...` や `Sleep` など）はありません。UEFN のチュートリアルのコードは、そのままでは動かないことがあります。
- `verse.exe` には別のフォルダのモジュールを読み込むオプション `--mount` がありますが、まだ実装されていません。モジュールは `Main` と同じファイルの中に定義します。

## バージョンの管理

`Versions/` には、エンジンのコミットごとに、取得するディレクトリの一覧とバイナリ依存の一覧が入っています。

| ファイル | 内容 |
|---|---|
| `sparse-paths.txt` | git の sparse checkout で取得するディレクトリ |
| `gitdepsignore.txt` | エンジンの `GitDependencies` が取得するバイナリ依存のホワイトリスト。Setup が `.gitdepsignore` としてコピーする |
| `version.json` | コミット、確認したかどうか、ダウンロード量の見積もり |

Setup は確認済み（`"verified": true`）のバージョンを既定にします。確認していないバージョンを選ぶと警告を表示します。
`-Version` にフォルダ名かコミットの先頭部分を渡すと、質問せずにそのバージョンを使います。

### 新しいエンジンのコミットを追加する（メンテナー向け）

1. エンジンをフルで clone し、エンジンの `Setup.bat` を実行しておく。
2. 一覧を生成する。

   ```powershell
   .\Tools\New-VersionManifest.ps1 -EngineDir 'F:\Epic Games\UE_Github'
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
