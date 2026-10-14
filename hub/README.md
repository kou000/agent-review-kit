# review-hub — 統合レビューシェル

計画 / 差分レビュー / E2E計画 / E2E結果 を **1 つのブラウザページ（ヘッダタブ切替）** に統合表示する
ローカルツール。agent-review-kit（ark、`$AGENT_REVIEW_KIT_DIR`）のページを**無改修のまま iframe で埋め込み**、
タブごとの承認ボタン（計画承認・E2E 実行承認・PR 作成承認）を提供する。

- 依存ゼロ（Node 標準ライブラリのみ・ビルドなし）。Node 18+
- 127.0.0.1 バインドのローカル専用（認証なし・外部公開しない）
- 状態はすべて `~/.review-hub/` のファイル。対象リポジトリには何も書かない
- エージェント向けの操作手順は `skills/my-review-hub/SKILL.md`

## 仕組み

```text
ブラウザ  http://localhost:5280/s/<セッションID>
┌──────────────────────────────────────────────┐
│ [計画 ✓] [差分(backend) 2] [E2E計画] [E2E結果] │ ← タブバー + 承認ボタン
├──────────────────────────────────────────────┤
│ ✓計画 › 実装 › … | 作業メモ | 集計 | [⏸中断]  │ ← ステータスバー（フェーズ進行・中断ボタン）
├──────────────────────────────────────────────┤
│ iframe                                        │
│   ark-doc  → http://localhost:<arkPort>/doc/<id>   (publish-html したドキュメント)
│   ark-diff → http://localhost:<arkPort>/           (generate した diff レビュー)
│   static   → hub 自身が配信（E2E フルレポート。動画は Range 対応でシーク可）
└──────────────────────────────────────────────┘
```

- ark の URL は各プロジェクトの `.agent-review/server.json` から**リクエスト毎に解決**する。
  ark を再起動してポートが変わっても、ブラウザ側のポーリング（2.5 秒）で自動追従する
- タブの件数バッジは hub サーバが ark の `/api/comments` を取得して数える
  （ark は CORS ヘッダを返さないため、ブラウザから直接は取れない）。数え方は ark サイドバーの
  「コメント (要確認 N / 未解決 M)」と同じ**スレッド単位**で、タブ（doc / diff）ごとに絞る:
  - **要確認**（赤塗り。ark の tree-count と同色）: 回答・修正済み / wontfix / dismissed の確認待ち、または AI 指摘への返信待ち。ユーザーの番
  - **未解決**（薄い青地）: ユーザー名義の open/seen コメントを含むスレッド。エージェントの番
  バッジは数字のみ（ホバーの title で意味を表示）
  `status --session` では `tabs[].check` / `tabs[].unresolved` と `checkTotal` / `unresolvedTotal`
- iframe はタブ切替でアンマウントしない（非表示でも ark のポーリング・コメント下書きが生きる）
- 表示中のタブはブラウザの localStorage に覚え、リロード後も同じタブに戻る（iframe 内のスクロール位置は戻らない）
- タブはドラッグで並べ替え（ブラウザの localStorage のみ）、右クリック →「このタブを非表示」で隠せる
  （ヘッダの「非表示 N ▾」から再表示）。非表示は session.json の `hidden` に記録され、`status` の
  `tabs[].hidden` / `waiterScopes[].allHidden` に出る。エージェントは全タブが非表示のスコープの
  wait-comments を止めてよい（Stop フック check-review-waiters.sh もそのスコープは咎めない）

## セッションモデル

1 セッション = 1 チケット（フロー 1 回）。複数リポジトリ（backend / frontend / E2E）を跨ぐため、
状態は対象リポジトリではなく `~/.review-hub/sessions/<id>/` に置く。

- `session.json` — タブ定義・承認状態・フェーズ/ステータス・中断状態
- `events.jsonl` — 操作イベントログ（作成・タブ・承認・ステータス・中断/再開）。`status --session` の直近イベント欄の元
- `docspace/` — ドキュメント類（計画・E2E計画等）の publish 先として使う **非 git ディレクトリ**。
  ここで ark serve を起動すると ark のデータが固定スコープ（`no-git`）になり、
  作業リポジトリのブランチ切替の影響を受けない

## CLI

```bash
RH="node $REVIEW_HUB_DIR/bin/review-hub.js"

$RH serve [--port N]              # サーバ起動（フォアグラウンド常駐。既定ポート 5280〜自動スキャン）
                                  # Claude Code からは setsid nohup で切り離す（run_in_background は 2 時間で強制停止されるため）:
                                  #   mkdir -p ~/.review-hub/logs
                                  #   setsid nohup $RH serve > ~/.review-hub/logs/hub.log 2>&1 < /dev/null &
$RH start --session TICKET-123 --title "..." \
    --phases "計画,実装,差分レビュー,E2E,PR"     # セッション作成（既存なら再利用。--phases 省略時は左記が既定）
$RH set-status --session TICKET-123 --phase 実装 --note "コメント3件対応中"  # ステータスバー更新
$RH interrupt --session TICKET-123 [--note "..."]  # 中断を記録し、全 ark serve + hub を停止（サインアウト前用。note は自分用メモ）
$RH resume --session TICKET-123                    # 中断解除（再開時）
$RH add-tab --session TICKET-123 --id plan --title 計画 \
    --type ark-doc --project-dir <docspace> --doc-id plan \
    --approval-label "計画を承認して修正開始"
$RH add-tab --session TICKET-123 --id diff-backend --title "差分 (backend)" \
    --type ark-diff --project-dir ~/my-app
$RH add-tab --session TICKET-123 --id e2e-report --title E2E結果 \
    --type static --path ~/e2e-reports/TICKET-123 --approval-label "PR 作成を承認"
$RH wait-approval --session TICKET-123 --tab plan --timeout 6600   # 承認までブロック（中断で interrupted を返す）
                                  # 0（無期限）は使わない。Claude Code の run_in_background は 2 時間で強制停止されるため、
                                  # 110 分で {"status":"timeout"} を返させて起動し直す
$RH approve-status --session TICKET-123
$RH remove-tab --session TICKET-123 --id reproduce
$RH hide-tab --session TICKET-123 --id plan     # 非表示（ブラウザの右クリックと同じ）/ show-tab で解除
$RH url [--session TICKET-123]
$RH status --session TICKET-123     # 現況サマリ（フェーズ・承認・未解決数・直近イベント）。--session なしは一覧
$RH stop
```

すべて JSON を stdout に返す。`add-tab` は同じ `--id` で再実行すると定義更新（承認状態は保持）。

## HTTP API

| ルート | 内容 |
| --- | --- |
| `GET /` | 最新セッションへリダイレクト |
| `GET /s/<id>` | シェルページ |
| `GET /api/sessions` | セッション一覧 |
| `GET /api/session/<id>` | タブ定義 + 解決済み iframe URL + ark 死活/未解決数 |
| `POST /api/session/<id>/approve` | `{tabId, note?}` で承認記録 |
| `POST /api/session/<id>/tab-visibility` | `{tabId, hidden}` でタブの非表示を記録（タブの右クリックメニュー / 「非表示 N ▾」メニュー） |
| `POST /api/session/<id>/interrupt` | `{note?}` で中断記録 + 全セッションの ark serve と hub 自身を停止（ステータスバーの中断ボタン。サインアウト前の全停止用） |
| `GET /static/<sessionId>/<tabId>/<path>` | static タブの配信（Range 対応） |

hub はフェーズを跨いで常駐する前提。例外は `/interrupt`（中断ボタン）で、これは
サインアウト前の全停止用途のため ark serve を止めたうえで hub 自身も終了する。

## 注意

- ark ページ内の「レビュー終了」ボタンは **ark サーバを停止させる**。承認はタブ上部の
  承認ボタンで行い、「レビュー終了」は押さない（復旧手順は my-review-hub スキルの手順 8）
- ark の doc（publish-html）は CSP により外部ファイル参照不可。E2E の動画・スクショを
  そのまま見せたい場合は static タブ（hub 配信）を使う
