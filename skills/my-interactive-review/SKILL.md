---
name: my-interactive-review
description: 修正完了後に agent-review-kit でレビューHTMLを生成し、ユーザーがブラウザで書いた差分コメントを Codex または Claude Code の同一セッションで受け取り、回答・修正・resolve を未解決0件まで繰り返すレビューループ。AIレビューの指摘を add-comment でブラウザ上のコメントとして表示し、ユーザーが返信した指摘だけ修正する「AIレビューモード」も含む。実装プラン・設計書などの任意HTMLを publish-html でレンダリング済みのまま表示し、要素クリック・テキスト範囲でコメントを受け取る「HTMLレビューモード」も含む。他のレビュースキルの結果の出力先として agent-review-kit が指定された場合も、このスキルを読んで AI レビューモードの手順に従うこと。Use when the user wants to review changes in a browser (GitHub-like diff review), review a rendered HTML doc (plan/design doc) in a browser, iterate on fixes with inline comments, or display AI review findings as browser comments (output target: agent-review-kit).
---

# my-interactive-review

agent-review-kit を使って、ユーザーとブラウザ経由のレビューループを回す。
このスキルを実行しているメインセッションは**受付とオーケストレーションに徹する**: コメントを待ち、読み、トリアージし、質問に回答し、修正結果を検証して resolve する。**コード修正そのものはサブエージェントに委譲する**（「修正の委譲」参照）。
**コメントごとに別の Codex / Claude Code セッションを起動しない。**レビュー開始から終了まで、スキルを起動した同じメインセッションを継続する。

## 前提

- `agent-review-kit` コマンドが使えること。このスキルは agent-review-kit リポジトリに同梱されているため、基本はそのローカルクローンの CLI を使う（`node <repo>/dist/cli.js <command>`）。グローバルインストール済みなら `agent-review-kit` で直接呼べる。npm 未公開のため `npx agent-review-kit` は使えない（未確認の同名パッケージを `npx` で取得しない）。
- 対象プロジェクトの作業ディレクトリ（git リポジトリ）で実行すること。`.agent-review/` がそこに作られる。

## Codex でのバックグラウンド実行

Codex では `serve` と `wait-comments` をそれぞれ長時間実行できるターミナルセッションとして起動する。`exec_command` を短い `yield_time_ms` で呼び、返された `session_id` を保持する。完了通知がない環境では、空入力の `write_stdin` を最大30秒程度の `yield_time_ms` で呼んで出力を回収する。

- シェルの `&` で切り離さない。Codex が追跡できるターミナルセッションを使う。
- `serve` 用と `wait-comments` 用の `session_id` を混同しない。
- `activeWaitSessionId` を1つだけ管理する。値がある間は新しい waiter を起動しない。セッション結果を回収したら値をクリアし、`received` ならコメントを処理キューへ追加してから次の通常 waiter を1本だけ起動する。
- `wait-comments` が1バッチを返すと、そのターミナルセッションは正常終了する。出力を回収してから次の待機を新しいセッションで開始する。
- レビュー中は最終回答を返してタスクを閉じない。短い進捗をユーザーへ伝えながら、終了シグナルまで待機・対応を続ける。
- Claude Code では同じ役割をバックグラウンドタスクと完了通知で実現する。以降のレビューロジックは共通とする。

## 設定（settings）の扱い

設定はユーザーがブラウザの歯車メニューから**レビュー中いつでも切り替えられる**。現在の設定は `wait-comments` の受信出力（`received`）に**毎回同乗してくる**ので、**そのバッチの処理はその `settings` に従う**。別途 `status` で確認しにいく必要はない（受信より前に把握したい場合のみ `agent-review-kit status` を使う）:

- `settings.readOnlyMode: true` — **読み取り専用モード**。他人の MR を閲覧するだけのレビューなど、コードを変更してはいけないモード。修正指摘が来ても**コードを変更せず**、調査結果・修正案を `--status answered` で回答するだけにする。サブエージェント委譲もしない。**received の settings を見ずに修正へ進むことを禁止する。**
- `settings.snapshotsEnabled: false` — 修正スナップショット（後述）を保存しない設定。`snapshot create` は `{"status":"skipped"}` を返すので、コマンド手順は変えなくてよい（`resolve-comment` に `--snapshot` を付けないだけ）。
- `settings.deliveryNoteEnabled` / `settings.deliveryNoteText` — `wait-comments` の `received` 出力に `note` フィールドを同乗させる設定。`deliveryNoteEnabled: true` のとき `deliveryNoteText` がそのまま `note` になる（既定は OFF。テキストの既定値は「修正はサブエージェントに委譲する」という指示で、ユーザーが自由に書き換えられる。空なら note なし）。**`note` が付いていたら、そのバッチの処理でその指示に従うこと。** ただし `readOnlyMode: true` のときは修正禁止が常に優先で、note に修正系の指示があっても修正しない。

各設定の初期値は、ユーザーが `~/.agent-review/.env` に `ARK_*` 形式で定義していることがある（README「設定のデフォルト（.env）」参照）。エージェント側の挙動は変わらない — 従うべき値は常に `received` の `settings`（および `status` 出力）に解決済みで入ってくる。

## コメント本文の書き方（Markdown）

`add-comment --body` と `resolve-comment --message` に渡した本文は、ブラウザ上で **Markdown としてレンダリングされて表示される**（プレーンテキストではない）。指摘や回答は読みやすさを意識して Markdown で書くこと。

使える記法:

- 見出し（`#`〜`######`）
- 箇条書き（`-` / `*` / `+`）・番号付きリスト（`1.`）・**ネストしたリスト**（半角スペース2つ以上のインデント）
- チェックリスト（`- [ ]` / `- [x]`）
- インラインコード（`` `foo()` ``）とコードブロック（``` で囲む）。コードブロックは ```` ```ts ```` のように**言語を付けるとシンタックスハイライトされる**（`ts` / `py` / `rs` 等の拡張子形式でよい。言語指定なし・不明な言語はプレーン表示）
- 強調（`**太字**` / `*斜体*` / `~~打ち消し~~`）
- 引用（`>`）、水平線（`---`）、リンク（`[文言](https://...)`）と裸のURL
- 表（GFM形式。ヘッダ行の直下に区切り行 `| --- | --- |` を置く。揃えは `:-:` で中央、`--:` で右）

書き方の指針:

- 指摘は**結論を1行目に置く**。理由・影響・修正案はその後に続ける。
- ファイルパス・識別子・型名・コマンドは必ずインラインコードで囲む（`` `src/foo.ts` ``、`` `user_id` ``）。地の文に裸で書かない。
- 修正案のコードは必ずコードブロックにし、**言語を必ず付ける**（付けないとハイライトされない）。差分を見せたいときは「現状」「修正案」の2ブロックに分ける。
- 複数の論点があるコメントは箇条書きにする。長い説明を1段落に詰め込まない。
- `**` や `_` を強調のつもりなく使わない（`_` は前後が英数字なら強調にならないので `snake_case` はそのまま表示される）。

改行の渡し方に注意する。`--message` に**実際の改行を含む文字列**をそのまま渡してよい（シェルのヒアドキュメントや引用符で複数行を渡す）。実改行が渡せない場合は `\n` という2文字で書けば表示時に改行として扱われる。

## 添付画像（imagePaths）の扱い

ユーザーはコメントフォームにスクリーンショット等をペーストして添付できる。添付があるコメントは `received` で `imagePaths`（画像ファイルの**絶対パス**の配列）を持って届く（バッチには説明の `imagesNote` も同乗する）。**内容の確認が必要なコメントについてのみ**、そのパスを Read ツールで読み込んで画像として参照すること（全コメントの画像を無条件に読まない — トークン節約のためのパス渡しである）。サブエージェントに修正を委譲する場合は、委譲プロンプトに `imagePaths` のパスをそのまま含め、サブエージェント側で Read させる。

コメント本文中に `[画像: img_xxx.png]` 形式のマーカーが入っていることがある。これはユーザーが画像をペーストした位置に自動挿入されたもので、`imagePaths` の各パスの末尾のファイル名（id）と突き合わせれば、本文中のどの位置について貼られた画像かを特定できる。

## コメント種別（intent）の扱い

ユーザーはコメント投稿時に「修正依頼」か「質問（回答のみ・修正しない）」を選べる。選択結果は各コメントの `intent` フィールドとして `wait-comments` の出力に入ってくる。**コメント本文を読む前に `intent` を見て、そのコメントの扱いを決める**:

- `intent: "question"` — **そのコメント1件だけの読み取り専用モード**。コードを調査して回答するだけにし、**コードを変更しない**（サブエージェント委譲もしない）。修正が必要だと判断した場合も、修正案を提示するだけにとどめ、`--status answered` で返す。ユーザーが修正を望むなら改めて「修正依頼」のコメントが届く。
- `intent: "fix"` — 従来どおり本文で判断する（修正指摘なら修正、実質的に質問なら回答）。
- `intent` が無いコメント（`add-comment` で投稿した AI 指摘、古い `comments.json`）も従来どおり本文で判断する。
- `manualEdit: true` のコメント（本文が `【手動修正】` で始まる） — ユーザーがブラウザの手動修正機能で直接書き換えた通知。**修正は適用済みで、コード対応は不要**（サブエージェント委譲もしない）。内容を確認したら `--status resolved` で resolve するだけでよい（snapshot は作らない。このコメントはブラウザには表示されないので、返信メッセージも不要）。対象が2種類ある:
  - diff レビュー（`file` あり）— working tree のファイルが変わっているので、以降そのファイルを扱うときは必ず読み直す。
  - HTML レビュー（`documentId` あり）— 保存済み文書（`.agent-review/branches/<ブランチ>/documents/<id>.html`）が変わっている。**この文書を `publish-html` で再公開すると手動編集が上書きされる**ため、以後この文書を更新する場合は保存済みの現在の内容を読み込み、それを基に編集して publish する。

`settings.readOnlyMode: true` の間は、ブラウザの選択肢が「質問」に固定され、サーバー側でも投稿されたコメントの `intent` が強制的に `question` になる。したがって読み取り専用モードでは全コメントが `intent: "question"` で届く。仮に `intent: "fix"` を見ても `readOnlyMode: true` なら修正しない（**修正しない側が常に勝つ**）。

## 手順

1. 対象 git リポジトリのルートを確認し、以降の全コマンドをそのディレクトリで実行する。Codex の各ツール呼び出しでも、このパスを `workdir` に指定する。

   ```bash
   git rev-parse --show-toplevel
   ```

   サブディレクトリのまま実行すると `.agent-review/` の位置とレビュー対象がずれるため、そのまま進めない。リポジトリルートへ移動したらレビューHTMLを生成する。

   ```bash
   agent-review-kit generate
   ```

   ブランチ全体をレビュー対象にする場合は、比較先ブランチ名をそのまま指定せず merge-base を base にする:

   ```bash
   BASE_REF=$(git merge-base main HEAD)
   agent-review-kit generate --base "$BASE_REF"
   ```

   `agent-review-kit generate --base main` は `main...HEAD` ではなく `main..現在のworking tree` 相当になり、現在ブランチに未取り込みの `main` 側変更が逆向きの差分として混ざることがある。未コミット差分だけをレビュー対象にする場合は、base を指定せず `agent-review-kit generate` を使う。

2. serve を起動する。ポートは固定ではなく、`.agent-review/server.json` に記録された実ポートを使う。

   まず、このプロジェクトの serve が既に生きているか確認する。`server.json` があり、そのポートの `/api/status` が返す `projectDir` が現在のプロジェクトディレクトリと一致すれば起動済み:

   ```bash
   PORT=$(node -p "String(require('./.agent-review/server.json').port)" 2>/dev/null)
   [ -n "$PORT" ] && curl -s "http://localhost:$PORT/api/status" | grep -F "\"projectDir\": \"$(pwd)\""
   # → マッチすれば起動済み。それ以外（server.json なし・curl 失敗・projectDir 不一致）は未起動扱い
   ```

   （`jq` はこの環境にない前提。`node -p` の数値出力は色コードが混ざることがあるため `String()` で包む）

   未起動なら、`agent-review-kit serve` をバックグラウンドで起動する。Codex では「Codex でのバックグラウンド実行」に従い、短く yield して返された `session_id` を `serve` 用として保持する。ポートは 5179 から空きを自動選択して `server.json` に記録される。起動出力または `server.json` から実ポートを取得する。

   **注意: `projectDir` の一致確認を省略しない。** 別プロジェクトの serve が同じポートで生きていると、curl が成功してしまい、ユーザーが別プロジェクトの diff にコメントを書く事故になる。

3. ユーザーに「http://localhost:<実ポート> を開いてレビューしてください」と伝える（`<実ポート>` は `server.json` の値）。
   行番号クリックで単一行コメント、Shift+クリックまたはドラッグで行範囲コメントができることも添える。

4. コメントを待つ。**レビュー開始後の最初の1回だけ** `--resume` を付ける。前のエージェントセッションが受信済みのまま中断した `seen` コメントも、新規 `open` コメントと一緒に回収できる:

   ```bash
   agent-review-kit wait-comments --timeout 0 --resume
   ```

   Codex ではこのコマンドを追跡可能なターミナルセッションとして起動し、`wait-comments` 用の `session_id` を保持する。出力を回収するときは、そのセッションへ空入力の `write_stdin` を送る。受信すると `{"status": "received", "note": "...", "settings": {...}, "comments": [...]}` が stdout に返り、該当する `open` コメントは `seen` になる。`settings` は受信時点の設定で、**このバッチの処理方針はここに従う**（「設定（settings）の扱い」参照）。`note` は設定に応じて同乗する処理指示（無いこともある）。**付いていたら必ず従う**。

   受信した waiter の終了結果を回収して `activeWaitSessionId` をクリアし、コメントを処理キューへ追加する。その後、`--resume` を外した新しい waiter を**1本だけ**開始し、その新しい session id を保存する:

   ```bash
   agent-review-kit wait-comments --timeout 0
   ```

   `--resume` を2回目以降にも付けると、現在対応中の `seen` コメントが重複配達されるため禁止する。新しい待機はサブエージェントの作業中も生かしておき、完了通知またはセッション出力を後で回収する。CLI が `another wait-comments process is already running` を返したら再試行で増やさない。現在のタスクが保持する既存 session id を使い、所有していない waiter なら PID を kill せず、前のタスクの終了を確認してから最初の `--resume` をやり直す。

   ユーザーがブラウザの「レビュー終了」ボタンを押すと `{"status": "finished", "comments": []}` が返る。`finishing = true` として新しい waiter は起動しない。すでに受信済み・対応中の処理キューは破棄せず、検証・resolve まで完了してから手順12へ進む（AI指摘の見送りとサーバー停止自体はサーバー側で完了済み）。

   `{"status": "interrupted", ...}` が返った場合（または serve が「シグナルにより停止」と出力して終了した場合）は、ユーザーが中断ボタン等で意図的に止めている。**障害ではないので、wait-comments・serve を自動で再起動しない**。ユーザーの明示指示（「再開して」等）を待つ。

   `--resume` が前回セッションの取りこぼし回収を兼ねるため、ブランチ別の `comments.json` を手作業で探索しない。

5. 受け取った各コメントを読む。`intent` / `file` / `side` / `startLine`〜`endLine` / `body` を確認する。
   - `intent: "question"` のコメントは**修正せず回答だけ**する（「コメント種別（intent）の扱い」参照）。手順6へ進み、手順7には進まない。
   - `file: null` のコメントは特定の行ではなくレビュー全体への指摘・質問（`side` / 各行番号も null）。
   - 行範囲コメント（startLine ≠ endLine）の場合は、範囲全体のコードを読んで指摘の意図を解釈する。1行だけ見て対応しない。
   - `side: "old"` は変更前（削除側）の行に対するコメント。削除やリファクタへの指摘であることが多い。
   - `parentId` を持つコメントは既存コメントへの返信。親コメント・その `agentResponse`・同じスレッドの他の返信を含むスレッド全体を読んで文脈を解釈すること（agent の回答への追撃質問であることが多い）。返信のアンカー（file/side/各行番号）は親からコピーされ、`parentId` は常にトップレベルの親を指す（スレッドは1段ネスト）。
   - 対応前に `git diff` で現在の変更状態を確認する。

6. コメントが**質問**（`intent: "question"`、または `intent` 未指定で本文が質問）なら、コードを調査して回答をまとめ、次で返す:

   ```bash
   agent-review-kit resolve-comment <id> --status answered --message "回答内容"
   ```

7. コメントが**修正指摘**なら、まず**そのコメントの `intent`** と**そのバッチの `received.settings.readOnlyMode`** を確認する（`intent: "question"` または `readOnlyMode: true` なら修正せず、修正案を `answered` で回答する）。修正する場合、メインセッションは自分でコードを編集せず、**サブエージェントに委譲する**（1件だけでも委譲する。方針は「修正の委譲」）。

   **修正はコミットせず、スナップショットとして記録する。** git 履歴を汚さずに「この指摘に対する修正だけ」の差分ページをユーザーに見せられる。流れ:

   ```bash
   # (1) shared working tree ならサブエージェントを起動する【直前】、
   #     isolated worktree / patch ならメインへ取り込む【直前】に現状を記録
   agent-review-kit snapshot begin

   # (2) 変更を取り込み、メイン側で型チェック/テストを通す

   # (3) この修正の patch を保存し、スナップショット id を得る
   agent-review-kit snapshot create --comment <コメントid> --title "対応内容の短い説明"
   # → {"status":"created","snapshot":{"id":"snap_xxx",...}}

   # (4) スナップショットリンク付きで resolve する
   agent-review-kit resolve-comment <コメントid> --status fixed --message "対応内容の説明" --snapshot snap_xxx
   ```

   `--snapshot` を付けると返信に「📄 修正差分」リンクが表示され、ユーザーがクリックするとその修正だけの差分を新しいタブで確認できる（コミット不要・ローカル完結）。`--snapshot` には `--message` が必須。テスト・型チェックの実行は必須で、失敗したまま fixed にしない。

   - サブエージェントが worktree 内で**コミット済み**の場合は、begin/create の代わりに `snapshot create --comment <id> --commit <そのsha>` でそのコミットの差分を patch として取り込める（worktree のコミットは共有 object DB 経由で解決される）。
   - `snapshot create` が `{"status":"skipped"}` を返したら設定でスナップショットが OFF。`--snapshot` を付けずに resolve する。
   - **メインブランチへのコミットはユーザーが明示的に指示した時だけ行う**（粒度は「コミット指示への対応」参照）。

8. 対応すべきか**判断できない**場合は、理由を書いて返す:

   ```bash
   agent-review-kit resolve-comment <id> --status answered --message "判断できない理由と選択肢"
   ```

   対応しない判断をユーザーと合意済みの場合は `--status wontfix` を使う（`wontfix` は判断の記録なので解決済みにはならず、画面では「要確認」として残る。ただしエージェント側の作業待ちではないので `unresolved` からは外れる）。

9. コードを修正し、まだ `finishing = false` の場合は、レビューHTMLを再生成する（コメントは保持される）:

   ```bash
   agent-review-kit generate --preserve-finished
   ```

   `--base` を省略しても前回 generate の base が引き継がれるので、ブランチ全体レビューの再生成でもそのまま実行してよい。`--preserve-finished` は、再生成と同時にユーザーが終了ボタンを押しても終了シグナルを消さないために必須。ブラウザ側は自動でリロードされる。`finishing = true` なら再生成せず、受信済みコメントの resolve と最終検証だけを終える。

10. 現在の状態を確認する:

    ```bash
    agent-review-kit status
    ```

    `unresolved`（open + seen）が未解決コメント数＝エージェント側の作業待ち。`wontfix` / `dismissed` は解決済みには数えないが（解決済みは `resolved` だけ）、待っているのはユーザーの確認なので画面上は「要確認」として残るだけで `unresolved` には含まれない。

11. 未解決コメントが残っている、またはユーザーのレビューが続いている間は、すでに保持している `activeWaitSessionId` の結果を回収する。値がない場合に限り、手順4の通常待機（`--resume` なし）を1本起動する。`received` を回収したら処理キューへ追加して再び1本だけ待機を起動する。`finished` を回収したら `finishing = true` とし、待機を再起動せず処理キューを drain する。

12. 次のいずれかでループを終了し、対応内容をまとめて完了報告する:
    - `wait-comments` が `{"status":"finished"}` を返し、受信済み・対応中の処理キューが空になった（ユーザーがブラウザの「レビュー終了」ボタンを押した）
    - `unresolved` が 0 になり、ユーザーが会話でレビュー完了を示した

    会話上でレビュー完了を示した場合は、最終回答の前に実ポートへ `POST /api/finish` を送り、`wait-comments` が `finished` で終了し `serve` も停止したことを確認する。これによりバックグラウンドセッションを残さない。ブラウザ側ですでに終了済みなら再送しない。

    ```bash
    curl -s -X POST "http://localhost:<実ポート>/api/finish"
    ```

    コミットの指示があればここで対応する（「コミット指示への対応」参照）。

## コミット指示への対応

レビュー中の修正は working tree に未コミットのまま蓄積されている。ユーザーからコミットの指示を受けたら、指定された粒度でコミットする:

- **まとめて1コミット**: 現在の working tree をそのままコミットするだけ。
- **コメント単位でコミットを分ける**: `agent-review-kit snapshot path` が返す現在ブランチのディレクトリにある patch を、時系列（ファイル名の連番）順に再生する。各 patch は「その時点の working tree」を前提に作られているため、**先に最初の `snapshot begin` 時点の状態（`index.json` の `baselineTree`）を復元してから**再生する。レビュー開始時に未コミット変更があった場合、この復元を飛ばすと patch #1 が適用できない:

  ```bash
  # (0) 最終状態を tree として記録してから退避（安全ネット兼、再生後の検証基準。
  #     stash@{0} との diff は untracked ファイルが stash^3 に分かれて正しく比較
  #     できないため、必ずこの tree と比較する）
  SNAP_DIR=$(agent-review-kit snapshot path)
  git add -A && FINAL_TREE=$(git write-tree)
  git stash -u

  # (1) ベースライン（最初の snapshot begin 時点）を復元する。
  #     HEAD と一致していれば diff は空で、このコミットはスキップされる
  BASE_TREE=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1])).baselineTree)' "$SNAP_DIR/index.json")
  git diff HEAD "$BASE_TREE" > /tmp/ark-baseline.patch
  if [ -s /tmp/ark-baseline.patch ]; then
    git apply --index /tmp/ark-baseline.patch
    git commit -m "wip: レビュー開始時点の変更"   # メッセージ・扱いはユーザーに確認
  fi

  # (2) 連番順に、patch 適用 → コミット を繰り返す
  for p in "$SNAP_DIR"/0*.patch; do
    git apply --index "$p"
    git commit -m "fix: <index.json の該当エントリの title / commentId から要約>"
  done

  git diff "$FINAL_TREE"           # 空なら再生完了（最終状態を完全再現）。退避を破棄:
  git stash drop
  ```

  `git diff "$FINAL_TREE"` に差分が残る場合、それはスナップショットの外で行われた変更（手動編集など）。その差分を最後の別コミットにするかユーザーに確認する。patch 適用が失敗した場合は `git apply --3way --index` を試し、それでも駄目ならそこで停止し、stash を保持したまま状況を報告する。ユーザーの明示承認なしに `git reset --hard` しない。ベースラインのコミットを履歴に残したくない場合は、再生後に rebase 等での整理をユーザーと相談する。

## AI レビューモード

ユーザーが「AI にレビューさせたい」「まず自分（エージェント）でレビューして」と指示した場合の変形モード。ループの仕組み（serve / wait-comments / resolve / generate）は通常と同一で、**ループ開始前に自分が diff をレビューして指摘をコメントとして投稿する**前段だけが追加される。

1. 手順1〜2（generate / serve）まで通常どおり実行する。
2. レビュー対象の diff を読み、観点（バグ・セキュリティ・性能・可読性・規約）ごとにレビューする。指摘は1件ずつコメントとして投稿する。**本文は Markdown で書く**（「コメント本文の書き方（Markdown）」参照）:

   ```bash
   # 行に紐づく指摘
   agent-review-kit add-comment --file src/foo.ts --line 42 --body "指摘内容"
   # 行範囲
   agent-review-kit add-comment --file src/foo.ts --start-line 10 --end-line 20 --body "指摘内容"
   # レビュー全体への所感
   agent-review-kit add-comment --body "全体の所感"
   ```

   指摘は**現在の diff に含まれる行**に対して行う（diff 外の行は「現在の差分に位置づけできないコメント」として画面下部に落ちる）。`--side old` で削除側の行にも付けられる。
3. 投稿を終えたら、ユーザーに件数と URL を伝えて手順3〜4（案内・wait-comments）に進む。このとき「対応不要と判断した指摘は放置してよい（レビュー終了時に自動で見送りになる）」ことを一言添える。
4. **自分が投稿した指摘（AI コメント）はこの時点では処理しない。** wait-comments にも流れてこない（配達されるのはユーザー名義の open コメントだけ）。ユーザーが AI 指摘に**返信**したら、その返信が通常のコメントとして届くので、スレッド全体（親=自分の指摘）を読んで修正または回答する。修正の流れは手順7と同じ。返信の `intent` が `question` なら、親が自分の修正指摘であっても**修正せず回答だけ**する（画面の「🔧 修正を依頼」ボタンからの返信は常に `intent: "fix"`）。
   - **修正完了時は2つ resolve する**: 届いた返信コメントを `--status fixed --message ... [--snapshot ...]` で resolve し、**親の AI 指摘も `--status fixed` で resolve する**（親が open のまま残ると未解決カウントに残り続ける）。
5. ユーザーが返信しなかった AI 指摘は、「レビュー終了」ボタンの押下時にサーバーが一括で `dismissed`（見送り）にする。エージェント側での後始末は不要。

## HTMLレビューモード

diff ではなく、実装プラン・設計書・調査結果などの任意HTMLをブラウザでレンダリング済みのまま見せてレビューさせたい場合の変形モード。ユーザーは要素クリック（要素選択モード）または文章のドラッグ選択でコメントする。ループの仕組み（serve / wait-comments / resolve）は通常と同一で、`generate` の代わりに `publish-html` でHTMLを登録・更新する。

1. レビュー対象のHTML（実装プラン等）を生成する。自己完結HTML（インラインCSS、外部リソース参照なし、スクリプト不要）にすること。HTMLは加工されずそのまま保存されるが、表示は iframe + CSP のためスクリプトは実行されず、外部CDN画像・外部CSS 等の外部リソースは読み込まれない（「セキュリティ」参照）。
2. 登録する:

   ```bash
   agent-review-kit publish-html --input <path> --document-id <id> --title "<タイトル>"
   ```

3. サーバーが未起動なら手順2と同じ確認方法で `agent-review-kit serve` をバックグラウンド起動する。
4. ユーザーに `http://localhost:<実ポート>/doc/<id>` を案内する。「要素を選択してコメント」ボタンで要素クリック、または文章をドラッグ選択してコメントできることを添える。
5. コメントを待つ:

   ```bash
   agent-review-kit wait-comments --document-id <id> --timeout 0
   ```

   常にバックグラウンドで常駐させ、完了通知（バックグラウンドタスクの終了）で受信を判定する（`ps`/`pgrep` での生存確認はしない）。二重起動もしない（「注意」の項目と同じ）。

6. 届いたコメントの `htmlTarget`（`label` / `selectedText` / `contextBefore` / `contextAfter`）でどこへの指摘か特定し、`documentId` に対応するHTMLの本体に対応する。
7. 必要に応じて元のプラン・設計・HTML・関連ファイルを修正する。
8. 更新したHTMLを同じ `--document-id` と `--preserve-finished` で `publish-html` し直す（無印だと並行して届いた終了シグナルを消してしまう）。開いているブラウザは自動リロードし、既存コメントは可能な範囲で元の位置に再配置される（再解決できないものは「位置を特定できないコメント」に残る）。
9. 対応を記録する:

   ```bash
   agent-review-kit resolve-comment <id> --status fixed --message "..."
   agent-review-kit resolve-comment <id> --status answered --message "..."
   agent-review-kit resolve-comment <id> --status wontfix --message "..."
   ```

10. 未解決コメントが無くなるか、`wait-comments` が `finished` を返すまで手順5〜9を繰り返す。

HTMLレビューでも、修正はサブエージェントに委譲し、メインセッションは受付・トリアージ・回答・resolve に徹する役割分担は通常のdiffレビューと同じ（「修正の委譲」参照）。コメントの `intent` と `settings.readOnlyMode` も同様に尊重する（`intent: "question"` ならHTMLも元ファイルも書き換えず、回答だけ返す）。

## 修正の委譲

メインセッションは受付・トリアージ・回答・取り込み・検証・resolve・generate に集中し、コード修正そのものは**コメント1件でもサブエージェントに委譲する**。

- サブエージェントのモデルは**セッションより軽いモデルを相対指定**する（特定のモデル名をスキルにハードコードしない）。設計判断をともなう大きな修正だけ、セッションと同等のモデルを使ってよい。
- 一度に複数コメントを受け取った場合は「対応で触るファイル・領域」でグルーピングする。同じファイルを触るコメント群は1つのサブエージェントにまとめて渡し、グループ間は並列実行する。
- **コメントが1件ずつ届く場合も同じ規則で振り分ける**: 修正コメントを受信したら、実行中のサブエージェントの担当ファイル/クレートと重なる場合のみそのエージェントに追送する。重ならない場合は直列キューに入れず、**必ず worktree エージェントを即時起動して並列化する**。「実行中のエージェントに追送する方が楽」を理由に独立な修正を直列化しない。
- **スナップショット都合で直列化しない**: 並列 worktree の修正は worktree 内でコミットさせ、`snapshot create --comment <id> --commit <sha>` でコメント単位のスナップショットを作れる（手順7参照）。並列でもコメントごとの修正差分リンクは成立する。
- **1 エージェントに複数コメントの修正を任せるときも、スナップショットはコメント単位を崩さない**: メイン working tree で連続修正させて最後に 1 つの合算スナップショットにすると、各コメントの「修正差分」リンクが全修正混在になり読めない（実際に指摘を受けた）。複数件を任せる場合は worktree で**修正ごとにコミット**させ、`snapshot create --comment <id> --commit <sha>` をコメントごとに作ってから resolve する。メイン tree 直接編集で進めてしまった場合は、修正間で main 側から snapshot begin/create を挟む。
- 並列実行するサブエージェントは **git worktree で隔離**する（Claude Code の Agent ツールなら `isolation: "worktree"`）。同一 working tree 上での並列編集はしない。サブエージェントが1体だけならメインの working tree を直接編集させてよいが、その実行中に新たな修正コメントが来て追加のサブエージェントを起動する場合、後発は worktree で隔離する。
- クライアントが worktree 隔離を提供しない場合（Codex 等）、同じ working tree を共有するサブエージェントのコード編集は完全に直列化する（レビュー中に snapshotsEnabled が切り替わる可能性があり、別エージェントの変更が snapshot に混ざるため）。コード編集の並列化は isolated worktree / 独立 patch を使える場合だけ行う。
- 各サブエージェントには、担当コメントの全文・対象ファイル・検証コマンド（型チェック/テスト）を明示し、検証まで通させ、変更内容（worktree の場合はそのパスまたはブランチ）を報告させる。
- 完了後、メインセッションが変更をメインの working tree に取り込む。**コンフリクトしたらその時点でメインセッションが解決する**（並列化を諦める理由にしない）。
- `snapshot begin` から `snapshot create` までの pending 状態は現在ブランチに1つだけなので、複数修正の取り込みとスナップショット作成は必ず1コメント（または同じ原子的変更で解決するコメント群）ずつ直列に行う。並列エージェントの成果を一度に混ぜてから snapshot を作らない。
- `resolve-comment --status fixed` は、変更をメインに取り込み、**メイン側で型チェック/テストが通ってから**実行する。worktree 内で通っただけでは fixed にしない。
- 全グループの取り込みが終わったら `generate --preserve-finished` を再実行してレビューHTMLを更新する。

## 注意

- コメントごとに別のメインエージェントセッションを起動しない。このセッションがループの主体。受信・トリアージ・回答・resolve はメインセッションが行い、コード修正はサブエージェントが行う。
- 修正前に必ず現在の git diff を確認し、修正後に必ずテストまたは型チェックを実行する。
- `wait-comments --timeout 0` は**常にバックグラウンドで常駐させる**。サブエージェントの完了待ちの間もコメント受信を止めない。受信して返ってきたら（内容のトリアージ後に）すぐ再度バックグラウンドで起動し直し、レビュー中は監視が途切れないようにする。
- **wait-comments を二重に起動しない。** 再起動時は前のプロセスが終了していることを確認する。2本生きていると、新規コメントが stdout を誰も読まない側に消費され（`seen` 化だけされて）握り潰される。
- **waiter の起動コマンドには必ず監視対象ディレクトリへの明示的な `cd` を含める。** ark のコメントスコープは実行ディレクトリで決まるため、直前のコマンドの cwd（別リポジトリでの git 操作など）を暗黙に継承すると、無関係なスコープを監視する waiter ができてコメントを取りこぼす。起動後に `readlink /proc/<pid>/cwd` で監視先を確認するとより確実。
- **wait-comments の終了判定はバックグラウンドタスクの完了通知、または Codex のターミナルセッション結果で行う。`ps`/`pgrep` でプロセスの生存確認をしない。** wait-comments は open コメントを1バッチ受信すると stdout に書いて即終了する設計で、この「終了」がバックグラウンドタスクの完了通知として届く。したがって「バックグラウンドで起動 → 完了通知が来たら受信済み＝終了済み → トリアージ → 再起動」というイベント駆動のサイクルで回せばよく、プロセス一覧での生存確認は不要。むしろ LLM の推論ループでプロセス状態をポーリングするのは高コスト（毎回コンテキスト再読込＋推論）で誤りやすく、避ける。どうしても確認する場合は `pgrep -af "[w]ait-comments"` のように**先頭文字をブラケットで囲って自己マッチを除外する**こと。`pgrep -f wait-comments` は検索コマンド自身のシェルプロセス（コマンドライン文字列に "wait-comments" を含む）にヒットし、実際には動いていないのに「動いている」と誤検出する。
- 初回の `generate` は前回の終了マーカーを消し、レビュー中の `generate --preserve-finished` は保持する。終了直後に新しいレビューを始める場合は、所有している `wait-comments` と `serve` の終了を先に確認してから初回用の `generate` を実行する。PID だけを見て別プロセスを kill しない。
- ユーザーのブラウザには、`seen` のまま応答が滞留したコメントを open に戻す「エージェントに再送」ボタンがある。再送されたコメントは**同じ id** で再度 wait-comments に届くので、既に対応済み・対応中の id なら重複として扱い、現在の状況（対応中/検証中など）を `--message` で返す。
- 受信したら即トリアージする: 質問はサブエージェントの完了を待たずメインセッションがその場で回答（`answered`）し、実装が必要なものは「修正の委譲」の方針に従って委譲またはキューイングする。
- レビュー対象の diff を変えたい場合（例: コミット後に base を変える）は `generate --base <ref> --preserve-finished` を再実行する。
- ユーザーはコメントを論理削除できる（削除済みは wait-comments に配達されず、未解決数にも入らない）。対応中だったコメントが消えていたら、対応を中止してよい。
- `unresolved`（open + seen）にはユーザーが未対応の **AI 指摘も含まれる**。AI レビューモードでは「unresolved が 0 になるまで」を終了条件にせず、`finished` シグナルまたはユーザーの完了宣言で終了する。
- `wontfix` / `dismissed` は解決済みにはならず画面上は「要確認」として残るが、`unresolved` には含まれない（待っているのはユーザーの確認でエージェントの作業ではない）。`wait-comments` にも再配達されないので、これらを待ち続けても届かない。
- サイドバー下部にレビュー対象（base..HEAD）のコミット一覧があり、ユーザーはコミット単体の差分ページを開ける。エージェント側の操作は不要。
- **agent-review-kit 本体を更新した後は、進行中レビューなら `generate --preserve-finished` を再実行する**（`.agent-review/` の client/*.js / style.css は generate 時にコピーされるため、古いままだと新 UI・新 API が動かない）。
