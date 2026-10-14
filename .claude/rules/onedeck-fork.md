# Makeinu1/phase — OneDeck fork 用の追加指示

このファイルは fork 固有の文脈だけを足す。コード・設計・CR 注記・検証の規範は上流の
`CLAUDE.md` / `AGENTS.md` / `.claude/skills/` に従い、ここでは上書きしない。上流ファイルを
fork の都合で編集すると同期のたびに衝突するため、fork 固有の指示はこのファイルに置く。

## この repo の位置づけ

- `phase-rs/phase`（上流）: Rust 製の MTG ルールエンジン＋React クライアント。オーナー Matt Evans。
  OneDeck は自前 TypeScript エンジンからこちらへ乗り換え済み。
- `Makeinu1/phase`（本 repo）: 上流の fork。目的は (1) 汎用的な致命的進行バグの解消、
  (2) Cloudflare 無料枠での2人/4人オンライン運用、(3) OneDeck モック M0〜M6 で言語化した体験と安全性
  （日本語、Manual Resolution、安全な Undo 等）を Phase へ反映すること。
- `Makeinu1/MTG_OneDeck`: 旧 TypeScript 製品。要求と触り心地を言語化した**モック**であり、
  そのコードを Phase へ移植する指示ではない。要求の参照元としてのみ使う。

## ブランチ

- `main`: 上流追随の基準。fork 固有の製品差分を直接積まない（このファイル等の運用文書は例外）。
- `deploy/onedeck-play`: OneDeck の現在の公開経路。`.github/workflows/onedeck-*.yml` と
  `scripts/onedeck-publish/` で Cloudflare Pages へ配信する。
- topic: `fix/*`・`cf/*`・`codex/*`・`experiment/*` 等。上流 PR の head になるものは PR 番号と対応させ、
  merge 確認後に削除する。保存目的だけの branch を残さない。

作業開始時は上流との差を確認する（clone 直後は `upstream` remote が無い）:

```sh
git remote add upstream https://github.com/phase-rs/phase.git 2>/dev/null; git fetch upstream main
git rev-list --left-right --count origin/main...upstream/main
```

## 上流への貢献フロー

1. fork の Issue に目的・症状と根拠・対象と除外・受入れ条件・候補 SHA と検証・次の一手を短く書く。
   Issue が実装指示の正本。
2. fork 上で実装し、exact SHA・diff・integration base・tests/gates・scope を独立検証する。
   CI green だけで完了としない。
3. 上流へ PR を出す。PR は小さく一つの root cause に絞り、上流の規範（CR 注記の grep 検証、
   engine がロジックを持つ、frontend は表示層）を満たす。
4. **merge の判断と実行は上流オーナーが行う。助手は merge / auto-merge / merge queue 投入をしない。**
   上流の `ship-commits`・`pr-review-loop`・`pr-contribution-handler` skill は上流メンテナ向けなので使わない。
5. 上流 merge を確認したら最新上流 main で post-merge 検証し、fork の branch・Issue・worktree を片付ける。
   上流 merge は OneDeck の公開完了を意味しない。

maintainer 待ちの候補は凍結し、別の独立 slice を進める。同じ候補の writer は一人。

## 製品境界（Phase 内で守ること）

- ゲームルール・状態・秘密情報・transaction authority は Phase 内で一本化し、第二のエンジンを作らない。
- 未対応効果は Manual Resolution で進行を継続できるようにする。Correction を新しいゲームイベントに
  しない（再誘発させない）。actor・choice・Room・privacy の責務を分ける。
- 既存の consensual takeback と solo rewind を維持したうえで、strict knowledge-safe Undo を扱う
  （秘密・乱数の境界を越える取り消しは拒否）。
- 無料運用は Pages / Worker / R2 と browser・host-authoritative P2P が前提。ロビーへデッキ・秘密・
  対戦状態を流さない。サーバー authority の GameDO 構想を復活させない。
- 日本語 UI は `client/src/i18n/` の i18next リソースで扱う。カード名・能力文の表示も engine 提供の
  ローカライズ済みデータを使い、frontend で再解釈しない。

## 状態の正本

- 変動情報（head、status、候補 SHA、PR の状態）は文書へ埋め込まず、fork Issue と live PR を正本にする。
  上位の進行は fork Issue #1〜#5（M7-1〜M7-5）。
- 運営契約・ロードマップ・監査照合は branch `codex/phase-ops-contract-20260930` の
  `docs/fork-operating-contract.md`・`docs/fork-roadmap.md`・`docs/audit-reconciliation.md`。
- 過去の会話・古い完了報告・古い snapshot を現在の HEAD の証拠にしない。

## 権限

commit・push・PR 作成・Issue/PR コメント等の外部書込みは、ユーザーが承認した対象と範囲でのみ行う。
秘密情報、TURN/Cloudflare 認証情報、Room ID・招待コードをログ・Issue・PR・文書へ書かない。
体験や方向性を変える判断はユーザーに相談する。
