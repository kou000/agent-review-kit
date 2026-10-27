---
name: my-review-hub
description: "計画・差分レビュー・E2E計画・E2E結果を 1 つのブラウザページ（タブ切替）に統合表示する review-hub の操作手順。agent-review-kit のページを iframe で束ね、タブごとの承認ボタン（計画承認・E2E実行承認・PR作成承認）を ark のコメント（【承認】）として wait-comments で受け取る。ステータスバー（フェーズ進行・作業メモ）と中断ボタン、セッション再開手順（status / resume）も定義する。計画→実装→PR のように承認ゲートを挟むフロー系スキルから参照される。Use when a skill needs to show plans, diffs, or E2E results in one tabbed browser page, wait for a browser-side approval gate, or resume an interrupted review session."
allowed-tools: [Bash, Read, Write]
---

# review-hub 操作手順（統合レビューシェル）

review-hub は agent-review-kit（以下 ark）を**無改修のまま** iframe で束ね、
1 つのブラウザページにタブ（計画 / 差分 / E2E計画 / E2E結果 …）と承認ボタンを提供するローカルツール。

- 本体: `$REVIEW_HUB_DIR`（既定は agent-review-kit 内の `hub/`）
- 状態: `~/.review-hub/`（サーバ情報・セッション・docspace）。対象リポジトリには何も書かない
- ark 側の操作（generate / publish-html / wait-comments / resolve 等）は **my-interactive-review の手順に従う**。
  このスキルは「どこに載せるか・承認をどう受けるか」だけを定義する

## 呼び出し方

```bash
REVIEW_HUB_DIR="${REVIEW_HUB_DIR:-${AGENT_REVIEW_KIT_DIR:-$HOME/agent-review-kit}/hub}"
RH="node $REVIEW_HUB_DIR/bin/review-hub.js"
# ark は PATH に無い環境があるため、無ければ直接呼ぶ:
ARK="agent-review-kit"; command -v agent-review-kit >/dev/null || ARK="node ${AGENT_REVIEW_KIT_DIR:-$HOME/agent-review-kit}/dist/cli.js"
```

すべてのコマンドは JSON を stdout に返す。

## 1. サーバ起動・再利用判定

hub サーバは全セッション共用で 1 本（ポート 5280〜、127.0.0.1）。二重起動しない:

```bash
PORT=$(node -p "String(require(require('os').homedir()+'/.review-hub/server.json').port)" 2>/dev/null)
[ -n "$PORT" ] && curl -sf "http://localhost:$PORT/api/sessions" >/dev/null && echo "already running: $PORT"
```

起動していなければ **setsid nohup で切り離して**起動する（`run_in_background` は使わない。
Claude Code 2.1.285 以降、`run_in_background` の Bash は timeout（最大 2 時間）で強制停止され、
hub ページが開けなくなるため）:

```bash
mkdir -p ~/.review-hub/logs
setsid nohup node $REVIEW_HUB_DIR/bin/review-hub.js serve > ~/.review-hub/logs/hub.log 2>&1 < /dev/null &
```

hub はフェーズを跨いで常駐する。フロー完了後も止める必要はない（止める場合は `$RH stop`。
また中断ボタンでそのセッションのサーバが止まり、他に動いているセッションが無ければ hub も止まる — 手順 6）。

## 2. セッション開始と docspace ark

セッション ID は原則チケット番号（例 `TICKET-123`）:

```bash
$RH start --session TICKET-123 --title "TICKET-123 ○○の修正" --phases "計画,実装,差分レビュー,E2E,PR"
```

- `--phases` はフローのフェーズ列（ステータスバーに進行表示される）。省略時は
  `計画,実装,差分レビュー,E2E,PR`。バグ修正フローなら `再現,設計,修正,E2E,PR` のように
  実際の流れに合わせる。既存セッションに `--phases` 付きで start し直すと差し替えられる

計画・E2E計画・E2Eサマリなどの**ドキュメント類は必ず docspace に publish する**。
docspace は `~/.review-hub/sessions/<id>/docspace/`（`start` の出力の `docspaceDir`）。
非 git ディレクトリなので ark のデータが固定スコープ（`no-git`）になり、
**作業リポジトリのブランチ切替の影響を受けない**（作業リポジトリに載せると checkout で doc が 404 になる）。

```bash
cd <docspaceDir> && $ARK publish-html --input <plan.html> --document-id plan --title "実装計画" 2>/dev/null
mkdir -p ~/.review-hub/logs
# setsid nohup で切り離して起動（このセッションで 1 本だけ。run_in_background は 2 時間で強制停止されるため使わない）
cd <docspaceDir> && setsid nohup $ARK serve > ~/.review-hub/logs/ark-<セッションID>-docspace.log 2>&1 < /dev/null &
```

- 作業リポジトリ / worktree の差分レビュー用 ark serve（手順 4 (b)）も同じく切り離して起動する
  （例: `cd <repoDir> && setsid nohup $ARK serve > ~/.review-hub/logs/ark-<セッションID>-<repo名>.log 2>&1 < /dev/null &`）。
  コメントの配達は serve ではなく `wait-comments`（`comments.json` の監視）が行うので、serve を切り離しても届く

waiter 監視フック（Stop フック check-review-waiters.sh）を導入している環境では、
レビュー作業を始めるセッションは、**フックの所有者ファイルに自分のセッション ID を書く**（ID は scratchpad パス中の UUID）。
これを書いたセッションだけがフックの検査対象になる（他セッションの誤ブロック防止）:

```bash
echo "<セッションID>" > ~/.review-hub/waiter-owner-session
```

- docspace は非 git のため ark が `fatal: not a git repository` を stderr に出し続ける（無害だが
  タスク出力を汚す）。**docspace での ark コマンドは `2>/dev/null` を付ける**
- docspace の ark では `generate` / `snapshot` を使わない（git 前提のため）。doc の修正は同じ
  `--document-id` に `--preserve-finished` を付けて publish-html し直す（revision が上がりブラウザは
  自動リロード、コメントは再配置される）。無印だと並行して届いた終了シグナルを消してしまう
  （diff 側のレビュー中の `generate` 再実行も同様に `--preserve-finished` を付ける）

### ドキュメント HTML の体裁（テンプレート必須）

デザインを生成エージェント任せにせず、**共通テンプレート CSS を必ず使う**（ダークテーマで統一）:

```bash
{ echo "<style>"; cat "$REVIEW_HUB_DIR/templates/doc-style.css"; echo "</style>"; cat <本文.html>; } > <doc.html>
```

- 本文は `<div class="doc">…</div>` で包む。見出し・表・コード・リストは素の HTML タグでよい
  （テンプレートが `.doc` 配下に効く）
- `h2` / `h3` に `id` を振り、`h1` 直後に**リンク付き目次**を必ず入れる（script 不可のため静的リンクで書く）:
  `<nav class="toc"><div class="toc-title">目次</div><ul><li><a href="#sec1">…</a><ul><li><a href="#sec1-1">…</a></li></ul></li></ul></nav>`
  （`ul` の入れ子で h3 が字下げされる）
- 表のセルには**短い値**（ファイル名・OK/NG・数値・一語の分類など）だけを入れる。表示領域は狭い
  （コメントパネルと並ぶ）ため、横長の表は読みにくい:
  - セルに文が入るなら表にしない。項目ごとに `h3` か太字の見出しを立て、箇条書きで書く
  - 列は 5 つ程度まで。超えるなら行と列を入れ替えるか、観点ごとに表を分ける
  - テンプレートは表を本文幅より広げ、収まらない分は横スクロールにするが、これは最後の手段と考える
- 補助クラス: `class="meta"`（薄字の日付行）/ `class="ok"`（PASS 等の緑）/ `class="warn"`（黄）/
  `class="note"`（枠付き注記）
- script 不可・画像は data URI のみ・全体 5MB 上限（ark の sanitize / CSP 制約）
- hub に載せた doc は、publish-html した後に hub で表示を確認する。表のセルの文字色、本文の `.doc` の付け忘れ、
  style ブロックの欠落を見る

## 3. ステータス更新（フェーズ・作業メモ）

hub ページ上部のステータスバーに「いまどのフェーズで何をしているか」が常時表示される。
承認状態・未解決コメント数はバーに自動集計されるが、**フェーズと作業メモだけは手動更新**:

```bash
$RH set-status --session TICKET-123 --phase 実装 --note "計画承認済み。ロジック修正中"
```

- **フェーズが変わるたびに必ず呼ぶ**（承認受領後・E2E 開始時・PR 作成前など）。
  `--phase` は start 時の phases のいずれかに限定される（進行表示と対応させるため）
- `--note` は「いま何をしているか」を 1 行で。コメント対応の開始/完了など、
  フェーズ内でも状況が変わったら note だけ更新してよい（`--note` 単独で可）
- これは**ユーザーが hub を開いた時とセッション再開時の唯一の状況表示**。
  更新を怠ると「今なにをしているか」が分からなくなる

### 返事待ち一覧

ユーザーは hub しか見ていないので、ターミナルに書いた質問・判断の依頼は届かない。
ステータスバーの「返事待ち N件」に同じ内容を出す:

```bash
$RH set-waiting --session TICKET-123 --item "push してよいか" --item "plan::案 A と案 B のどちらで進めるか"
$RH set-waiting --session TICKET-123 --clear
```

- **ユーザーの返事を待っている事項をターミナルに書くときは、同じ内容を set-waiting で hub にも出す**。
  1 項目 1 行。関係するタブがあれば `<タブid>::` を前に付ける（一覧の行を押すとその文をコピー、行のタブ名チップを押すとそのタブに切り替わる）
- 呼ぶたびに一覧を丸ごと置き換える。片付いたら残りだけで呼び直し、無くなったら `--clear` で空にする
- 一覧に載せるのは返事待ちと判断したものだけ（作業メモ・承認待ち・コメント件数は載せない。承認とコメントはバーに自動で出る）

## 4. タブ登録（3 種）

```bash
# (a) ドキュメント（計画・E2E計画・E2Eサマリ）— docspace の ark doc を埋め込む
$RH add-tab --session TICKET-123 --id plan --title 計画 \
  --type ark-doc --project-dir <docspaceDir> --doc-id plan \
  --approval-label "計画を承認して修正開始"

# (b) 差分レビュー — 作業リポジトリの ark（generate + serve 済み）を埋め込む
$RH add-tab --session TICKET-123 --id diff-backend --title "差分 (backend)" \
  --type ark-diff --project-dir <repoDir> \
  --approval-label "差分レビュー完了"

# (c) 静的レポート — E2E フルレポート等のディレクトリを hub が直接配信（動画再生可）
$RH add-tab --session TICKET-123 --id e2e-report --title "E2E結果" \
  --type static --path <reportDir> --entry index.html \
  --approval-label "PR 作成を承認"
```

- 同じ `--id` で再実行すると定義更新（承認状態は保持）。承認をやり直させたいときは
  `remove-tab` してから add-tab し直す
- `--approval-label` を付けたタブにだけ承認ボタンが出る。ラベルは「何が起きるか」が
  分かる文言にする（例:「計画を承認して修正開始」「差分レビュー完了」「E2E 実行を承認」「PR 作成を承認」）
- 差分タブの「差分レビュー完了」は**ユーザーが差分を見終えた合図**。未解決コメント 0 件は
  AI 側の完了条件で、ユーザーの完了とは別。PR/MR 作成前に両方が揃っていることを確認する
- **タブの非表示**: ユーザーはタブを右クリックして非表示にできる（ヘッダの「非表示 N ▾」から再表示）。
  非表示は session.json に記録され、`$RH status --session <id>` の `tabs[].hidden` と
  `waiterScopes[]`（ark タブを projectDir = waiter スコープごとに束ねたもの。`allHidden` 付き）で分かる。
  CLI から隠す/戻すなら `hide-tab` / `show-tab`。add-tab で定義更新しても非表示は保持される
- **差分タブは AI レビューを開始する前に登録して URL を案内する**（ユーザーが AI レビューの
  完了を待たずに並行して差分レビューを始められるようにする。AI の指摘は後から同じタブに載る）。
  E2E 計画タブも作れる状態なら同じタイミングで並列に登録してよい（差分と E2E 計画を同時にレビューできる）
- 計画の承認ゲートはこの hub の承認ボタンで受ける。**プランモード（EnterPlanMode / ExitPlanMode）は
  使わない**（プランモードだと計画が hub に出せず、承認ゲートが二重になるため）
- タブ追加後、ユーザーには **hub の URL を 1 本だけ案内**する（`$RH url --session <id>`）。
  ark の URL や `file://` パスを併記しない（迷いのもと）
- セッションを新しく作って最初に URL を案内するときだけ、その URL をブラウザで開く（`cmd.exe` が無い環境では何もしない）。
  同じセッションでタブを追加したとき・再開（resume）のときは開かない（タブが増えるため）:

  ```bash
  command -v cmd.exe >/dev/null && cmd.exe /c start "" "<hub の URL>" >/dev/null 2>&1
  ```

## 5. コメントと承認の待ち受け

承認ボタンは push 依頼ボタンと同じく **ark のコメント**としてエージェントに届く。コメントも承認も
ark `wait-comments` だけで待つ（**`wait-approval` は使わない**。承認専用の待ち受けは止まっていても
誰も気づけず、承認が黙って失われるため）。スコープごとの waiter を**バックグラウンドで並走**させ、
完了通知で先に返った方に反応する。ポーリング（ps/pgrep や短周期リトライ）はしない:

```bash
# waiter はスコープごとに 1 本だけ。二重起動禁止（wait-comments は 2 本生きると片方が結果を握り潰す）
cd <docspaceDir> && $ARK wait-comments --timeout 6600          # docspace 宛（全 doc）で 1 本
cd <repoDir> && $ARK wait-comments --diff-only --timeout 6600         # 差分レビュー用に repo ごと 1 本
```

**承認コメント**: 本文が `【承認】` で始まるコメント（`【承認】「<ボタンのラベル>」が押されました（タブ: <タブ名>）`）。
投稿先はタブ種別で決まる: ark-doc タブ → そのドキュメント宛（`documentId` 付き）、ark-diff タブ → その repo の
ark の全体コメント、static タブ（E2E結果など）→ docspace の全体コメント。タブの ark が止まっていれば
docspace の全体コメントに回る。届いたら:

1. どのゲートの承認かをラベルで判断する（`$RH approve-status --session <id>` でも確認できる）
2. **追加指示**を確認する: 承認バーの入力欄に書かれた内容が、1 行目の後に空行を挟んで本文に続く
   （`approve-status` の `note` と同じ）。追加指示はユーザーの指示として、既定の「次フェーズへ進む」より優先する。
   「承認後そのまま MR 作成まで進めて」のように**以降の承認ゲートを省く指示もそのまま従う**
   （呼び出し元のフロー系スキルのゲートで止まり直さない。ただし省いたゲートのタブ追加・`set-status` は通常どおり行う）
3. `resolve-comment <id> --status answered --message "承認を受けて<次にやること>を開始します"` で受領を返す。
   追加指示があれば、それをどう扱うかも書く（例:「承認と追加指示を受けて、実装から MR 作成まで続けて進めます」）
   （返信するまで未解決として残り、ユーザーには「受け取られていない」ように見える。
   スレッドを閉じるのはユーザーなので `--status resolved` にはしない）
4. 次フェーズへ進む（`set-status` でフェーズも更新する）

hub の承認バーには承認コメントの配達状況（受信待ち / 受信済み）が出る。1 分以上未受信だと警告が出て、
ユーザーは「承認を確認して」と言ってくる。そのときは waiter の棚卸し（下記）をして欠けたスコープを再起動する
（再起動直後の wait-comments が未配達の承認コメントを返す）。

- waiter は `run_in_background: true` の Bash で起動し、Bash の timeout は `7200000`（2 時間）にする
  （終了が完了通知になるため、serve と違って切り離さない）。**`--timeout 0` は使わない**:
  Claude Code 2.1.285 以降は 2 時間で強制停止され、以降コメント・承認が黙って配達されなくなる。
  `--timeout 6600`（110 分）なら強制停止の前に `{"status":"timeout"}` で自分から終わる。
  **`timeout` は失敗ではなく「起動し直せ」の合図**なので、同じスコープで同じコマンドを再起動する

- コメントが届いたら my-interactive-review の手順でトリアージ・回答・修正・resolve し、
  waiter を再起動する
- **waiter の再起動は「発火したスコープだけ」ではなく全スコープの棚卸しで行う**。
  コメント対応を終えてターンを締める前に、生きているべき waiter を数え上げて突合する:
  1. 必要本数 = docspace 1 本 + 差分レビュー中の repo ごとに 1 本（承認もこの中で届くので別に数えない）。
     ただし **`status` の `waiterScopes[]` で `allHidden: true` のスコープは除く**（ユーザーが
     そのスコープのタブを全部非表示にした = そこにはコメントしない意思表示。生きている waiter は kill してよい。
     Stop フックもそのスコープの waiter 不足を咎めない）。一部だけ非表示のスコープは 1 本必要
  2. 結果を返して終了した waiter は自動では復活しない。終了したまま放置されたスコープ宛の
     コメントは open のまま誰にも配達されず、ユーザーには「無視された」ように見える
  3. 足りないスコープは再起動する。再起動直後の wait-comments は waiter 不在中に届いた
     open コメントを即座に返すため、取り逃し分はこの再起動で回収できる
  4. 2 本以上生きているスコープは 1 本になるまで kill する（片方が結果を握り潰すため）
  5. 非表示だったタブが再表示されると `hidden` が消え、次のターン終了時に Stop フックが
     そのスコープの waiter 再起動を要求する。再起動直後の wait-comments が待ち受け不在中の
     open コメントを配達するので、再表示後のコメントは失われない（エージェントの次のターンまで遅れるだけ）

  よくある事故: スコープ A の waiter が発火 → 対応 → A だけ再起動して、**前のターンで発火して
  止まったままのスコープ B を忘れる**。計画 doc と差分レビューが並走するフェーズで特に起きやすい

  棚卸しは記憶に頼らず、**必ずこのコマンドで実測する**（コメント対応ターンの最後に実行）:

  ```bash
  # 各 wait-comments の実スコープ（cwd）を列挙。先頭文字のブラケットで棚卸しコマンド自身への自己マッチを除外する
  # bash ラッパと node 子が対で出るので node 側で数える
  for pid in $(pgrep -f '[w]ait-comments'); do echo "$pid $(readlink /proc/$pid/cwd 2>/dev/null)"; done
  ```

  出力のスコープ一覧と「必要本数（docspace + レビュー中 repo/worktree ごと）」を
  突合し、欠けているスコープを再起動する。実行せずにターンを終えない
- waiter を kill するときは `kill $(pgrep -f '<パターン>')` を素で使わない。実行中のシェル自身の
  コマンドラインにもパターンが含まれるため、自分のシェルごと kill してしまう。
  コマンドラインが `node` で始まるプロセスだけに絞る:
  `for pid in $(pgrep -f '[w]ait-comments'); do tr '\0' ' ' < /proc/$pid/cmdline | grep -q '^node ' && kill $pid; done`
  （スコープを限定するなら `readlink /proc/$pid/cwd` も突合する）
- `wait-comments` の返り値: コメント（承認コメントを含む）`{"status":"received",...}` /
  中断 `{"status":"interrupted",...}`（→ 手順 6）/ タイムアウト `{"status":"timeout"}`（→ 同じスコープで再起動する）
- 承認済みかの確認だけなら `$RH approve-status --session <id> [--tab <id>]`

## 6. 中断と再開（中断ボタン・セッション再開手順）

ステータスバーの**中断ボタン**は「このチケットの作業を止める（サインアウト前など）」ためのもの。押されると:

- 中断が記録され、**このセッションの ark serve（docspace・作業リポ）とそのスコープの wait-comments が停止する**。
  稼働中の他セッション（同じホストで別の hub を立てている別チケットを含む）が使っている ark は止めない
- hub サーバ自身は、止めても他セッションの表示が途切れない場合だけ終了する（別の hub プロセスが動いている、
  または稼働中の他セッションが無い）。ブラウザには終了メッセージが固定表示される
- 全チケットを一度に止めたいとき（サインアウト前など）は CLI の `$RH interrupt --session <id> --all`
  （全セッションに中断を記録し、全 ark と同じホストの全 hub を止める）
- 止められた wait-comments は `{"status":"interrupted", ...}` を返す。これがエージェントへの中断の通知
  （メモは `$RH status --session <id>` の `interrupted.note` で読む）
- メモは**ユーザー自身のための覚え書き**。再開後も保持され（`lastInterrupt`）、hub ページで
  未読なら一度だけ自動ポップアップ + ヘッダ右の「📝 中断メモ」ボタンでいつでも読み返せる。
  AI への引き継ぎはこのメモに頼らず、**AI 自身が `set-status --note` で残す**

**interrupted を受け取ったら**（作業は続行しない）:

1. 同じセッションの他の waiter が残っていないか確認し、残っていれば kill する
   （中断で hub が止めているのが通常。kill は手順 5 の `node` 始まりに絞る方法で行う）
2. `set-status --note` で中断時点の状態を記録する（何が済んで・何が残っていて・次に何をするか）
3. ユーザーに現状サマリを報告してターンを終える

**セッションを再開するとき**（中断後・コンテキスト切れ後・新セッションでの引き継ぎ時）は、
作業を始める前に必ず:

1. hub サーバが止まっていれば起動する（手順 1。他に動いているセッションが無ければ中断で hub ごと止まっている）
2. `$RH status --session <id>` の現況サマリ（フェーズ・作業メモ・承認状態・コメント件数・
   直近イベント）を読む（status は hub 未起動でも動くので 1 と 2 は逆でもよい）。
   件数は ark サイドバーと同じスレッド単位で、`unresolved`（未解決 = エージェントの作業待ち）と
   `check`（要確認 = ユーザーの確認待ち。AI 指摘の返信待ちを含む）に分かれる。
   自分がやるべき残作業は `unresolvedTotal` を見る
3. **最初にユーザーへ状況を報告する**（例:「いま実装フェーズ、差分レビューのコメント 2 件が未解決、
   E2E 実行承認待ちです。前回は○○まで完了しています」）。`interrupted.note`（ユーザーの
   中断メモ）があればそのまま見せる
4. 中断状態なら `$RH resume --session <id>` で解除する（ステータスバーの中断表示が消える）
5. 停止していた ark serve を再起動する（docspace / 作業リポで `$ARK serve` を手順 2 の
   setsid nohup の形で切り離して起動。ポートが変わっても hub が自動追従。doc は publish 済みのまま残っている）
6. フェーズに応じた waiter（スコープごとの wait-comments）を再起動し、hub の URL を案内して
   続きから進める

## 7. E2E サマリ doc の作り方（コメント可能な E2E 結果）

static タブのフルレポートには ark コメントが付けられないため、コメントを受けたい場合は
**サマリ doc（ark-doc）を併設**する:

- スクショは主要な数枚だけを縮小して **data URI** でインライン化する
  （ark の doc は CSP により外部ファイル参照不可・HTML 全体で 5MB 上限）
- 動画は埋め込まず、hub の static 配信 URL へのリンクにする:
  `<a href="http://localhost:<hubPort>/static/<session>/<staticTabId>/assets/xxx.webm" target="_blank">動画</a>`
  （ark のサニタイズは http リンクと target 属性を通す）
- 変換例: `base64 -w0 shot.png` の出力を `<img src="data:image/png;base64,...">` に入れる

## 8. 「レビュー終了」誤操作からの復旧

ark ページ内の「レビュー終了」ボタンは **ark サーバ自体を停止**させる（hub のタブに「!」が付き
接続不可の表示になる）。シェル上部に注意書きは常時出るが、押されてしまった場合:

1. 該当 ark の cwd（docspace または作業リポ）で publish-html（doc の場合）か `generate`（diff の場合）を
   **無印（`--preserve-finished` なし）で**再実行する — これが finished マーカーを解除する
2. 同じ cwd で `$ARK serve` を手順 2 の setsid nohup の形で再起動する（ポートが変わっても hub が次のポーリングで自動追従）
3. 注意: レビュー終了時に未返信の AI 指摘コメントは一括 dismissed になっている。
   必要なら add-comment で再掲示する

## 9. 後始末

- セッション終了（PR 作成完了）後、docspace / 各リポの ark serve は kill してよい。
  切り離して起動しているのでタスクとしては止められない。各 cwd の `.agent-review/server.json` の pid を kill する
  （`kill $(node -p "require('./.agent-review/server.json').pid")`）。hub は `$RH stop`（`~/.review-hub/server.json` の pid を止める）
- ark serve をすべて止めたら `rm -f ~/.review-hub/waiter-owner-session`（waiter 監視フックの解除）。
  中断ボタン経由の停止時（手順 6）も同様に削除する
- hub サーバは常駐可。セッションデータは `~/.review-hub/sessions/<id>/` に残る
  （不要になったらディレクトリごと削除してよい）
- static タブの参照先（E2E レポート等）を消すとタブは接続不可表示になる。
  レポートを残したい場合は消す前に退避する
