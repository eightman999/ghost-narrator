# ghost-narrator

伺かのゴースト（[Ourin](https://github.com/eightman999/Ourin) / SSP）が Claude Code の作業を SSTP で実況する Claude Code mod。

- 依頼・編集・コマンド実行・テスト PASS/FAIL・ガード拒否・完了などをゴーストのバルーンで実況
- Claude Code 内の「Ghost」ペインにシェル画像と台詞を表示（Ourin が無くても動く）
- 許可が必要なとき、バルーンに「許可・セッション表示・拒否」の選択肢を出して回答を受け付ける（90秒で通常の確認へ戻る）
- 完了・失敗時はバルーンから Claude デスクトップアプリのセッションへ戻れる

## 送信方式

`SEND SSTP/1.4` に `Event: OnClaudeCode`（Reference0 = 出来事の種類, Reference1 = 詳細）と `Script` を付けて送る。
ゴーストが `OnClaudeCode` を処理すればその台詞、処理しなければ同梱の定型 Script を再生する。

| transport | 経路 |
|---|---|
| `http` | SSTP over HTTP（`POST http://127.0.0.1:9801/api/sstp/v1`, `Content-Type: text/plain`） |
| `ipc` | Ourin の Distributed Notification（`jp.ourin.sstp.request` / `response`、macOS のみ） |
| `auto`（既定） | HTTP を試し、失敗したら IPC |

## 設定（userConfig）

| キー | 既定 | 内容 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:9801/api/sstp/v1` | SSTP over HTTP の受信口 |
| `receiver` | 空 | 送り先ゴースト名（`ReceiverGhostName`） |
| `transport` | `auto` | `auto` / `http` / `ipc` |
| `voice` | `template` | `template`: 定型文 / `ai`: haiku でゴースト口調の台詞を生成 |
| `shellDir` | `~/Documents/Ourin/ghost/emily4/shell/master` | ペインに描くシェル画像のフォルダ |
| `sessionLink` | `true` | 完了・失敗・停止時にセッションへ戻る選択肢を付ける |
| `permissionBalloon` | `true` | 許可確認をバルーンの選択肢で受け付ける |

## コマンド

`/ghost say <text>` / `/ghost test` / `/ghost pane` / `/ghost mute` / `/ghost unmute` / `/ghost status`

## SSP 互換性

> **状態: 仕様照合のみ・SSP 実機では未検証。** Ourin（macOS）で開発・動作確認している。

### SSP の仕様どおりのもの（UKADOC と照合済み）

| 項目 | 内容 |
|---|---|
| SSTP | `SEND SSTP/1.4` の `Event` + `Script` フォールバック、`Reference0`/`Reference1`、`ReceiverGhostName` |
| SSTP over HTTP | `POST /api/sstp/v1`、`Content-Type: text/plain`。`Origin` ヘッダを付けないためリモート扱いの制限を受けない |
| さくらスクリプト | `\q[タイトル,script:...]`、`\![open,browser,URL]`、`\![execute,http-get,URL,--nofile]`、`\*`、`\_q`、`\s[n]`、`\w8` |

### Ourin / macOS 専用のもの

| 機能 | SSP（Windows）での扱い |
|---|---|
| `transport: ipc` と `auto` の予備経路（Distributed Notification、`osascript`/JXA） | 使えない。`transport: http` を指定する |
| 許可バルーンの「セッション表示」（`open` コマンド） | 動かない（許可・拒否は動く想定） |
| バルーンの「セッションを開く」（`claude://` リンク） | Claude デスクトップアプリのセッション ID が前提 |
| `shellDir` の既定パス（`~/Documents/Ourin/...`）と表情パーツ番号（emily4） | `shellDir` を明示指定する。パーツ番号はシェル依存 |
| 許可バルーンの待受 | `python3` が PATH に必要 |

Windows の SSP では `transport: http` で実況・許可バルーン（許可／拒否）が動く見込み。不具合があれば Issue へ。

## ライセンス

MIT
