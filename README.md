# agent-review-kit

Claude Code のメインセッションと人間レビュアーをつなぐ、ローカル差分レビューツール。

エージェントが修正後にレビュー用HTMLを生成し、ユーザーはブラウザで GitHub の PR レビューのように差分へインラインコメント（行範囲選択対応）を書く。エージェントは `wait-comments` でコメントを受け取り、**同じセッションのまま**回答・修正・resolve を繰り返す。

```
Claude Code セッション                     ブラウザ (http://localhost:<実ポート>)
──────────────────────                    ─────────────────────────────
generate  ──► .agent-review/review.html ──►  side-by-side 差分表示
serve     ──► ローカルサーバー起動        ◄──  行/行範囲を選択してコメント
wait-comments ◄── comments.json ◄──────────  POST /api/comments
（コメントを読んで修正・回答）
resolve-comment ──► 状態更新 ─────────────►  画面に agent の返信が表示される
```

## 特徴

- **共通ツール**: 各プロジェクトには組み込まず、どの git リポジトリでも `agent-review-kit generate` するだけで使える。データはそのリポジトリの `.agent-review/` に置かれ、**ブランチ単位**（`branches/<ブランチ名>/`）で分離される — 別ブランチのレビューのコメントが混ざらない。
- **同一セッション処理**: コメントごとに別プロセスの Claude Code を起動しない。Skill の手順として `wait-comments` を実行し、受け取ったコメントを同じセッションが処理する。
- **GitHub ライクな UI**: side-by-side 差分、追加/削除/コンテキスト行の色分け、行番号クリックで単一行コメント、Shift+クリックまたはドラッグで行範囲コメント、インラインのコメントスレッド表示（折りたたみ対応）、未解決数バッジ、レビュー対象コミット一覧（Commits タブ相当）。
- **コミットしない修正差分**: 修正1件ごとの patch を**スナップショット**として保存し、`/snapshot/<id>` で指摘単位の差分ページを表示。git 履歴を汚さず、コミットはユーザーが指示した時だけ（patch の時系列再生でコメント単位のコミット再構成も可能）。
- **AI レビューモード**: エージェントが `add-comment` で指摘を AI 名義のコメントとして投稿。ユーザーが返信（または「🔧 修正を依頼」ボタン）した指摘だけが処理され、放置した指摘はレビュー終了時に自動で見送りになる。
- **画面上の設定とレビュー終了**: 歯車メニューでスナップショット ON/OFF・読み取り専用モード（修正させない）を切替。「レビュー終了」ボタンでコメント待機とサーバーを停止できる。
- **依存ゼロのランタイム**: サーバーは Node.js 標準ライブラリのみで動く。

## インストール

```bash
git clone <this-repo> agent-review-kit
cd agent-review-kit
npm install
npm run build
npm link        # グローバルに agent-review-kit コマンドを提供
```

`npm link` の代わりに、任意のプロジェクトから `node /path/to/agent-review-kit/dist/cli.js` で直接呼んでもよい。

## 開発

```bash
npm run dev -- generate        # tsx で src/cli.ts を直接実行
npm run typecheck              # 型チェック
npm run lint                   # ESLint
npm run build                  # dist/ にビルド（client 資産のコピーを含む）
```

## 使い方

すべてのコマンドは、レビュー対象の git リポジトリのルートで実行する。

### 1. レビューHTMLの生成

```bash
agent-review-kit generate              # working tree vs HEAD の差分
agent-review-kit generate --base main  # main と working tree の差分
```

- `.agent-review/review.html`（+ `app.js` / `style.css`）を生成する。
- レビューデータは**現在の git ブランチのディレクトリ**に置かれる:

```
.agent-review/
  review.html, app.js, style.css      # 今表示中のレビュー（リポジトリ共通）
  server.json                         # サーバー情報（リポジトリで1つ）
  branches/<ブランチ名>/
    comments.json                     # コメント（既存があれば保持）
    state.json                        # base と生成時刻
    settings.json                     # 画面の設定（スナップショット/読み取り専用）
    finished.json                     # レビュー終了マーカー（generate で消える）
    snapshots/                        # 修正スナップショット（patch + index.json）
```

ブランチを切り替えると、そのブランチのコメント・スナップショットだけが見える（旧バージョンの平置きデータは初回実行時に現在ブランチへ自動移行される）。

再実行するとHTMLだけが更新され、コメントは保持される。ブラウザは生成時刻の変化を検知して自動リロードする。

### 2. サーバー起動

```bash
agent-review-kit serve                 # 5179 から空きポートを自動選択し .agent-review/server.json に記録
agent-review-kit serve --port 8080
```

API:

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/comments` | 全コメント取得 |
| POST | `/api/comments` | コメント作成・返信 |
| PATCH | `/api/comments/:id` | body / status の更新 |
| POST | `/api/comments/:id/resolve` | status を `resolved` にする |
| POST | `/api/comments/:id/delete` | 論理削除（トップレベルは返信も連鎖削除） |
| GET | `/api/status` | 集計（未解決数・状態別件数・ブランチ・設定・生成時刻） |
| GET | `/api/commits` | レビュー対象（base..HEAD）のコミット一覧 |
| GET / PUT | `/api/settings` | 設定の取得 / 部分更新 |
| POST | `/api/finish` | レビュー終了（AI指摘を一括見送り→サーバー停止） |
| GET | `/commit/:sha` | コミット単体の差分ページ（読み取り専用） |
| GET | `/snapshot/:id` | 修正スナップショットの差分ページ（読み取り専用） |

データはブランチ単位のため、サーバー起動中にブランチを切り替えてもリクエストごとに現在ブランチのデータが返る。

`POST /api/comments` は通常 `file` / `side` / `startLine`〜`endLine` / `startDiffLine`〜`endDiffLine` / `body` を送るが、`file` を省略（または `null`）して `body` だけを送ると、特定の行に紐づかない**全体コメント**（レビュー全体への指摘・質問）として登録される。この場合 `file` / `side` / 各行番号は `null` になる。画面上部の「全体コメント」セクションから投稿・閲覧できる。

既存コメントへの**返信**は `parentId`（返信元コメントの `id`）と `body` を送る。返信のアンカー（`file` / `side` / `startLine`〜`endLine` / `startDiffLine`〜`endDiffLine`）は**親コメントからコピー**され、リクエストの位置情報は無視される（返信が親からずれない）。存在しない `parentId` を指定すると 400 になる。返信への返信を送った場合、`parentId` はそのスレッドの**トップレベルの親**に正規化され、スレッドは常に1段ネストで保持される。画面上では返信が親コメントの直下にインデント表示される。

### 3. コメント待機（エージェント用）

```bash
agent-review-kit wait-comments --timeout 0     # 無期限に待つ
agent-review-kit wait-comments --timeout 600   # 最大600秒待つ
```

**ユーザー名義**の `status: open` コメントが現れると、それらを `seen` に更新して stdout に返す（`add-comment` で投稿した AI 名義の指摘は配達されない — ユーザーの返信だけが届く）。受信時点の設定が毎回同乗するので、消費側は `readOnlyMode` 等を別途確認しなくてよい:

```json
{ "status": "received", "settings": { "snapshotsEnabled": true, "readOnlyMode": false }, "comments": [ { "id": "comment_xxx", "file": "src/example.ts", "side": "new", "startLine": 10, "endLine": 15, "body": "..." } ] }
```

タイムアウト時は `{ "status": "timeout", "comments": [] }`。ブラウザの「レビュー終了」ボタンが押されると `{ "status": "finished", "comments": [] }` を返して終了する（終了直前に投稿されたコメントの配達が優先される）。

### 4. コメントへの対応を記録（エージェント用)

```bash
agent-review-kit resolve-comment comment_xxx --status fixed --message "nullチェックを追加しました"
agent-review-kit resolve-comment comment_xxx --status answered --message "この値はAPI側で検証済みです"
# 修正スナップショットの差分リンク（📄 修正差分）を返信に添える（--message 必須）
agent-review-kit resolve-comment comment_xxx --status fixed --message "対応しました" --snapshot snap_xxx
# コミットの差分リンクを添える（--message 必須）
agent-review-kit resolve-comment comment_xxx --status fixed --message "対応しました" --commit <sha>
# 変更後のキャプチャを返信に添付（複数可、--message 必須。1枚あたり最大3MB）
agent-review-kit resolve-comment comment_xxx --status fixed --message "修正後の画面です" \
  --image ./before.png --image ./after.png
```

status: `open` / `seen` / `fixed` / `answered` / `wontfix` / `resolved` / `dismissed`（AI指摘の見送り）。
`--message` は `agentResponse` としてコメントに保存され、画面にインライン表示される。
`--snapshot <id>` はスナップショット（後述）の差分ページ `/snapshot/<id>` へのリンク、
`--commit <sha>` は `/commit/<sha>` へのリンクを返信に添える。
`--image <path>`（png/jpg/jpeg/gif/webp、複数回指定可）は画像を base64 data URI に
変換して `agentResponse.images` に保存し、返信の下に `<img>` でインライン表示する。
外部通信は発生せず（data URI で自己完結）、画面側は `data:` 画像のみを受け付ける。

### 5. 修正スナップショット（エージェント用）

修正を**コミットせずに**「この指摘に対する修正だけ」の差分ページとして残す仕組み。

```bash
agent-review-kit snapshot begin                       # 修正を適用する【直前】に現状を記録
# …修正を working tree に適用する…
agent-review-kit snapshot create --comment comment_xxx --title "対応内容"
# → {"status":"created","snapshot":{"id":"snap_xxx","seq":1,...}}  patch を保存
agent-review-kit snapshot list                        # スナップショット一覧
```

- patch は `git diff` 形式（`--binary --full-index`）で `snapshots/NNNN_snap_xxx.patch` に連番保存される。`git apply` でそのまま再適用できるので、**時系列順に apply + commit すればコメント単位のコミットを後から再構成できる**（最初の `begin` 時点の状態は `index.json` の `baselineTree` に記録される）。
- サブエージェントが worktree 内でコミット済みなら `snapshot create --comment <id> --commit <sha>` でそのコミットの差分を取り込める。`--patch-file <path>` で patch ファイルを直接渡すこともできる。
- 設定でスナップショットが OFF の場合、`snapshot create` は `{"status":"skipped"}` を返す（手順を分岐させなくてよい）。

### 6. AI レビューの指摘投稿（エージェント用）

```bash
agent-review-kit add-comment --file src/foo.ts --line 42 --body "[Warning] 指摘内容"
agent-review-kit add-comment --file src/foo.ts --start-line 10 --end-line 20 --body "..."
agent-review-kit add-comment --body "レビュー全体への所感"   # --file なし = 全体コメント
```

AI（agent）名義のコメントとして投稿され、画面では紫の「AI」バッジ付きで表示される。
投稿した指摘は `wait-comments` に配達されない。ユーザーが返信（または指摘カードの
「🔧 修正を依頼」ボタン）すると、その返信が通常のコメントとして届く。未返信の指摘は
「レビュー終了」時にサーバーが一括で `dismissed` にする。

### 7. 状態確認

```bash
agent-review-kit status
```

```json
{
  "branch": "feature/xxx",
  "total": 3,
  "unresolved": 1,
  "counts": { "open": 0, "seen": 1, "fixed": 1, "answered": 0, "wontfix": 0, "resolved": 1, "dismissed": 0 },
  "base": "main",
  "generatedAt": "2026-07-08T05:00:00.000Z",
  "settings": { "snapshotsEnabled": true, "readOnlyMode": false },
  "finished": null,
  "snapshots": 2
}
```

`unresolved` は `open + seen` の件数（論理削除済みは全集計から除外）。`finished` はレビュー終了ボタンが押された時刻（`generate` でリセット）。

## Skill として使う（Claude Code）

`skills/my-interactive-review/SKILL.md` にレビューループの手順が定義されている。Claude Code から使えるようにするには、ユーザースキルとしてリンクする:

```bash
ln -s /path/to/agent-review-kit/skills/my-interactive-review ~/.claude/skills/my-interactive-review
```

以降、Claude Code セッションで `/my-interactive-review` を実行すると、エージェントが

1. `generate` でレビューHTMLを生成し、`serve` を起動し、
2. ユーザーにブラウザレビューを依頼して `wait-comments --timeout 0` で待ち、
3. コメントを受けたら同一セッションで回答（`answered`）または修正+スナップショット（`fixed` + `--snapshot`）し、
4. `generate` を再実行してHTMLを更新し、レビュー終了シグナルまたは未解決0件までループする。

修正はコミットせず working tree に蓄積され、コミットはユーザーが指示した時だけ行う（まとめて1コミット、またはスナップショット patch の時系列再生でコメント単位に分割）。

SKILL.md には**AI レビューモード**（エージェントが先に diff をレビューして `add-comment` で指摘を投稿し、ユーザーの返信ベースで修正する）と**読み取り専用モード**（他人の MR レビュー用。修正せず回答のみ）の手順も含まれる。レビュー系スキル（例: `/my-code-review-ct`）の出力先として agent-review-kit を指定する連携もこの手順に乗る。

既存の自作スキル（例: `/my-feature`, `/my-auto-bugfix-tb`）の最終ステップから「修正完了後は my-interactive-review スキルの手順でレビューを受ける」と参照させると、実装 → セルフレビュー → 人間レビューのループが一本につながる。

## コメントのデータ形式

`.agent-review/branches/<ブランチ名>/comments.json`:

```json
{
  "comments": [
    {
      "id": "comment_xxx",
      "file": "src/example.ts",
      "side": "new",
      "startLine": 10,
      "endLine": 15,
      "startDiffLine": 120,
      "endDiffLine": 125,
      "body": "ここはnullチェックが必要では？",
      "status": "fixed",
      "createdAt": "2026-07-08T05:00:00.000Z",
      "updatedAt": "2026-07-08T05:10:00.000Z",
      "agentResponse": {
        "message": "nullチェックを追加しました",
        "updatedAt": "2026-07-08T05:10:00.000Z"
      }
    }
  ]
}
```

- `side`: `new` = 変更後の行、`old` = 変更前（削除側）の行
- `startLine` / `endLine`: 対象ファイル内の行番号（範囲コメント対応）
- `startDiffLine` / `endDiffLine`: `git diff` 出力上の行番号（差分内の位置の一意な参照）
- **全体コメント**（レビュー全体への指摘・質問）は `file` / `side` / `startLine` / `endLine` / `startDiffLine` / `endDiffLine` がすべて `null`。`body` のみを持ち、画面上部の「全体コメント」セクションに表示される。
- `parentId`: 返信元コメントの `id`（省略または `null` はトップレベルコメント）。返信のアンカーは親からコピーされ、`parentId` は常にトップレベルの親を指す（スレッドは1段ネスト）。返信は画面上で親コメントの直下にネスト表示される。
- `author`: `user`（省略時のデフォルト） / `agent`（`add-comment` で投稿された AI 指摘）。`agent` のコメントは `wait-comments` に配達されない。
- `deleted`: 論理削除フラグ。`true` のコメントは画面・集計・配達すべてから除外される（データは残る）。
- `agentResponse.snapshot` / `agentResponse.commit`: 返信に添えられた差分ページ（`/snapshot/<id>` / `/commit/<sha>`）への参照。

## 例: 一連の流れ

```bash
cd my-project
vim src/example.ts                          # 何か修正する

agent-review-kit generate
agent-review-kit serve &                    # 実ポートは .agent-review/server.json を参照
agent-review-kit wait-comments --timeout 0  # ブラウザでコメントを書くとここが返る
# → {"status":"received","comments":[{"id":"comment_abc", ...}]}

# 修正して…
agent-review-kit resolve-comment comment_abc --status fixed --message "対応しました"
agent-review-kit generate                   # HTMLを更新（ブラウザは自動リロード）
agent-review-kit status                     # unresolved が 0 なら完了
```

## 制約・注意

- 未追跡（untracked）ファイルは `git diff` に現れないため、レビュー対象にするには `git add -N <file>` などで意図的に追跡させる（スナップショットの patch には untracked も含まれる）。
- サーバーは localhost 向けのローカル開発ツールであり、認証はない。外部公開しないこと。
- 差分を再生成して行がずれたコメントは、画面下部の「現在の差分に位置づけできないコメント」に退避表示される。
- レビューデータはブランチ単位。ブランチを切り替えたら `generate` を再実行してレビューHTMLも切り替える。
- ツール本体を更新した後は `generate` を再実行する（`.agent-review/` の `app.js` / `style.css` は generate 時にコピーされるため）。
