# Phase Fork ロードマップ

版 1.0 — 2026-09-30 snapshot

作業手順と判断境界は [Fork 運営契約](fork-operating-contract.md) を参照する。

## 北極星

Phase 自体を、友人同士の実際の対戦が止まらず、正しく復旧でき、無料で運用できる基盤へ改善する。OneDeck は要求発見のモック。コードのコピーや巨大 framework の拡大を目的にしない。

三つの成果軸:

1. 汎用的な致命的進行障害を解消する。
2. Cloudflare の無料枠で成立する運用を確認する。
3. OneDeck モック M0〜M6 で言語化した体験と安全性を Phase に反映する。

## マイルストーン

以下は旧 OneDeck M0〜M6 や既存 Phase1 番号の置き換えではない。依存する実装を先に固め、独立した調査・整備は並行する。順序は固定しない。

### 対戦継続・復旧

**Exit:** 対象候補の再現ケース、正常系、兄弟事例、本番経路、中断復帰を独立検証し、本家 merge 後に最新 main で再検証して証拠を残す。

- #9388 Draw continuation と #9409 Concede recovery を本家受入れまで収束する。
- 再現ケース、正常系、兄弟事例、本番経路、中断復帰の証拠を揃え、本家 merge 後の検証をexit条件にする。CI green だけでは達成としない。
- 全バグゼロを終わりのない目標にしない。完了後は未解決の致命症状をlive evidenceで優先判断する。

### 無料運用

**Exit:** 明示した想定利用条件で Pages/Worker/R2/P2P の2人卓を作成・参加・対戦・再接続・終了まで通し、ロビーへ秘密/対戦内容が送られないことと有料必須依存の有無を確認して証拠と制限を記録する。想定規模は未実測なら未確定とする。

- 最新合意は Pages / Worker / R2 と browser・host-authoritative P2P。サーバー authority の GameDO や Worker 上で全カードengineを動かす旧構想を復活させない。
- 再現可能な build/deploy 手順、接続・再接続、静的資産・カードデータ配信を確認する。ロビーへデッキ、秘密、保存済み対戦状態を流さない。
- 課金機能、利用枠、通信制約を検証し、無料が成立する利用条件を明示する。実測前に達成と断定しない。
- #9190 maintainer 権限待ちは迂回せず、外部依存として扱う。

### 手動介入の一貫性

**Exit:** 未対応効果の手動解決から通常進行へ復帰し、Correction が新しい誘発を起こさず、他 seat の選択・秘密情報・Room 管理を混同しない代表シナリオを実画面と production 経路で検証する。

- Manual Resolution を未対応効果の正規の続行経路とし、意味付き Sandbox を保つ。Move を Draw / Destroy と誤認しない。
- Resolution、ManualEvent、Correction を区別し、Correction から再誘発しない。actor、choice、Room、privacy の権限を分離する。HOLD は操作権を奪わない。
- 既存の Phase authority に接続し、第二のengineを作らない。代表的な実画面シナリオから acceptance を定める。

### 安全なUndo

**Exit:** 可逆な最新操作は戻せる一方、他 actor の操作や知識/乱数境界を越える操作は拒否し、既存 takeback と solo rewind が回帰しない証拠を揃える。

- 既存の consensual takeback と solo rewind を維持し、任意の strict knowledge-safe Undo を追加する。
- 共有履歴で真に最新の1操作をLIFOで戻し、当該 actor の操作に限る。秘密・乱数の境界が不明なら拒否する。既知情報を未見に戻した扱いにしない。
- 技術方式は別 Issue で設計し、製品要件と分ける。

## 現在地（2026-09-30 13:10 UTC時点）

live GitHub 状態と候補 SHA の検証を最優先し、この文書の snapshot は参考情報とする。変動する状態の正本は各Issue。詳細head・statusはIssueで更新する。

- #9388 candidate `a518008…`: 21 focused tests と fmt は成功。独立review未完了。latest main との相互作用、red証拠、未完了gatesが残る。
- #9409 は公開 head `29d0104` を出発点に Issue #20 で修正中。ローカル状態は担当タスクで確認する。protocol番号は integration base 依存なので固定しない。
- #9252 / #9198 / #9357 は merged。#9249 は本家R2 baselineの権限に依存。#9190 は本家workflow受入れ待ち。

## 着手と見直し

着手前に、目的／マイルストーン、利用者の失敗、今やる理由、止まる条件、最小の証拠、他laneとの重複を説明できること。説明できない作業は着手しない。軽微な修正、カード追加、整理自体を目的にせず、同じ重大問題の再発や責務拡大が見えたら REPLAN する。

タスク選定前、bounded task完了時、本家merge後、重要reviewまたは前提変更時に現在地と次の一手を見直す。通常は差分だけを更新し、変化のない全文再読や文書増殖を避ける。
