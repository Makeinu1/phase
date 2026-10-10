#!/usr/bin/env python3
"""Capture a synthetic P1 fixture on the real product /game/:id route.

Use an existing Vite/ChromeDriver session. This records observations, not PASS.
The writer's fixture-specific read-only state script must be reviewed first.
"""
import argparse
import base64
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import zlib
import urllib.request


BOUNDED_K1_SCOPE = ('Local K1 checked-restore and real UI continuation to paid play22 with explicit fixture opponent driver; '
                    'K1-only acceptance when passed; full S8, opponent UI, two-client S9, '
                    'S1 life18/play21, Undo and full S1-S12 unaccepted')


S1_1A_SCOPE = 'S1-1a and S12c prepayment Manual UI with explicit fixture opponent passes; not full P1, opponent UI, two-client, Undo or Recovery acceptance'

AUTO_V_SCOPE = 'Fixed afe3 ordinary cost1 vanilla V2/2 Battlefield real own UI with explicit fixture B pass; not Manual/negative/full P1 acceptance'
AUTO_CONTROLS_SCOPE = 'Fixed afe3 ordinary Auto S20-to18 and standalone N20-to23 real own UI with explicit fixture B pass; not Manual/negative/full P1 acceptance'
S1_1C_SCOPE = 'S1-1c native original receipt lookup and client terminal cache reconciliation with latest UI18, prepayment Manual UI and paid play21; not adapter historical reply publication or full P1 acceptance'
RECORDED_1C_SCOPE = 'Matching candidate ordinary recorded start Manual20-to19-to18 Finish paid21 with actual original native resends registered-pending custody old-binding refusal and adapter historical publication; not full P1 or engine-in-flight acceptance'
NATIVE_ORIGINAL_SCOPE = 'Fixed afe3 actual UI qL1/qL2 terminal native resends and register-only refusals with fresh UI continuation; not qL2 precommit custody, adapter historical publication, wrong-actor UI, or full P1 acceptance'
MANUAL_SOURCE_TEXT_SCOPE = 'Matching runtime existing checked-native 1c.B ordinary Manual designation payment Begin20 with nonempty source text wide/narrow; source layout only, not recorded ordinary start, Apply, Finish, receipts or full P1 acceptance'


class EvidenceFailure(ValueError):
    def __init__(self, stage, reason):
        self.stage, self.reason = stage, reason
        super().__init__(reason)


def validate_manual_visual_observation(value, require_visible=False):
    def require(condition, reason):
        if not condition:
            raise EvidenceFailure('manual-visual', reason)
    require(isinstance(value, dict), 'source-layout-unavailable')
    require(value.get('diagnostic', 'missing') is None and value.get('warningVisible') is False
            and value.get('warningSuppressed') is False, 'false-stuck-warning')
    require(value.get('cardContentPresent') is True and value.get('cardContentKind') in
            {'loaded-image','artless-fallback'}, 'source-card-content-missing')
    def rect(name):
        r = value.get(name)
        require(isinstance(r, dict) and all(type(r.get(k)) in {int, float} for k in
                ['left', 'right', 'top', 'bottom', 'width', 'height'])
                and r['width'] > 0 and r['height'] > 0, 'source-layout-rect:' + name)
        return r
    source, card, details, form = (rect(k) for k in ['source', 'card', 'details', 'form'])
    def inside(r):
        return (r['left'] >= source['left']-1 and r['right'] <= source['right']+1
                and r['top'] >= source['top']-1 and r['bottom'] <= source['bottom']+1)
    def disjoint(a, b):
        return (a['right'] <= b['left']+1 or b['right'] <= a['left']+1
                or a['bottom'] <= b['top']+1 or b['bottom'] <= a['top']+1)
    require(inside(card) and inside(details), 'source-content-outside-source')
    require(disjoint(card, details) and disjoint(source, form), 'source-form-overlap')
    lines = value.get('lines')
    blocks = value.get('textBlocks')
    require(isinstance(blocks, list) and [block.get('kind') for block in blocks
            if isinstance(block, dict)] == ['title','oracle'], 'source-text-blocks-unavailable')
    for block in blocks:
        length = block.get('textLength')
        block_lines = block.get('lines')
        require(block.get('present') is True and type(length) is int and length >= 0
                and isinstance(block_lines, list), 'source-text-block-unavailable:' + block['kind'])
        require((length > 0 and len(block_lines) > 0) or
                (block['kind'] == 'oracle' and length == 0 and len(block_lines) == 0),
                'source-text-lines-unavailable:' + block['kind'])
    require(isinstance(lines, list) and lines == [line for block in blocks for line in block['lines']],
            'source-text-lines-unavailable')
    canonical=value.get('canonicalSourceText')
    require(isinstance(canonical,dict) and isinstance(canonical.get('source_name'),str)
            and canonical['source_name'] and isinstance(canonical.get('card_data_sha256'),str)
            and re.fullmatch(r'[0-9a-f]{64}',canonical['card_data_sha256'])
            and canonical.get('oracle_text_kind') in {'null','empty','nonempty'}
            and type(canonical.get('oracle_text_length')) is int and canonical['oracle_text_length'] >= 0
            and (canonical['oracle_text_length'] > 0) == (canonical['oracle_text_kind'] == 'nonempty'),
            'source-canonical-text-unavailable')
    require(value.get('titleMatchesFixture') is True
            and blocks[1]['textLength'] == canonical['oracle_text_length'], 'source-text-does-not-match-fixture')
    require(value.get('oracleTextCoverage') == ('observed' if blocks[1]['textLength'] > 0
            else 'not-present-in-fixture'), 'source-oracle-coverage-unavailable')
    for line in lines:
        require(isinstance(line, dict) and all(type(line.get(k)) in {int, float} for k in
                ['left', 'right', 'top', 'bottom']) and line['right'] > line['left']
                and line['bottom'] > line['top'] and inside(line) and disjoint(line, form),
                'source-text-outside-or-overlapping')
    if require_visible:
        visible=value.get('visible')
        require(isinstance(visible,dict) and all(type(visible.get(k)) in {int,float}
                for k in ['left','right','top','bottom']), 'source-visible-region-unavailable')
        def on_screen(r):
            return (r['left'] >= visible['left']-1 and r['right'] <= visible['right']+1
                    and r['top'] >= visible['top']-1 and r['bottom'] <= visible['bottom']+1)
        require(all(on_screen(r) for r in [source,card,details,*lines]), 'source-content-clipped')
    for prefix in ['source', 'panel']:
        width, scroll = value.get(prefix+'ClientWidth'), value.get(prefix+'ScrollWidth')
        require(type(width) is int and type(scroll) is int and width > 0 and scroll <= width+1,
                'source-horizontal-overflow:' + prefix)


def manual_scroll_plan(value):
    def require(condition,reason):
        if not condition: raise EvidenceFailure('manual-visual',reason)
    require(isinstance(value,dict),'manual-scroll-geometry-unavailable')
    ancestors=value.get('ancestors')
    require(isinstance(ancestors,list) and ancestors,'manual-scroll-owner-unavailable')
    owner=ancestors[0]
    require(owner.get('overflowY') in {'auto','scroll'},'manual-scroll-owner-unavailable')
    target,visible=value.get('target',{}),value.get('visible',{})
    numbers=[owner.get(k) for k in ['scrollTop','scrollHeight','clientHeight']]+[r.get(k) for r in [target,visible] for k in ['left','right','top','bottom']]
    require(all(type(n) in {int,float} and math.isfinite(n) for n in numbers),'manual-scroll-geometry-unavailable')
    current=owner['scrollTop'];maximum=owner['scrollHeight']-owner['clientHeight']
    require(0<=current<=maximum and owner['clientHeight']>0 and target['bottom']>target['top']
            and visible['bottom']>visible['top'] and visible['right']>visible['left'], 'manual-scroll-geometry-unavailable')
    require(target['left']>=visible['left']-1 and target['right']<=visible['right']+1,
            'source-horizontal-clipped')
    lower=max(0,current+target['bottom']-visible['bottom']-1)
    upper=min(maximum,current+target['top']-visible['top']+1)
    require(math.ceil(lower)<=math.floor(upper),'manual-scroll-target-unreachable')
    desired=min(max(round(current),math.ceil(lower)),math.floor(upper))
    require(value.get('originHitsOwner') is True,'manual-scroll-origin-blocked')
    origin=value.get('origin',{})
    require(all(type(origin.get(k)) is int for k in ['x','y']) and
            visible['left']<=origin['x']<=visible['right'] and visible['top']<=origin['y']<=visible['bottom'],
            'manual-scroll-origin-unavailable')
    return {'minimum':lower,'maximum':upper,'desired':desired,'deltaY':round(desired-current)}


def validate_manual_scroll(attempt):
    def require(condition,reason):
        if not condition: raise EvidenceFailure('manual-visual',reason)
    require(isinstance(attempt,dict) and attempt.get('target') in {'source','controls'}
            and attempt.get('input_kind')=='native-wheel','manual-scroll-proof-unavailable')
    before=attempt.get('before');plan=manual_scroll_plan(before)
    require(attempt.get('plan')==plan and attempt.get('wheel_count')==(1 if plan['deltaY'] else 0)
            and attempt.get('state_unchanged') is True,'manual-scroll-proof-mismatch')
    after,settled=attempt.get('after'),attempt.get('settled_after')
    require(isinstance(after,dict) and isinstance(settled,dict) and after==settled,'manual-scroll-not-settled')
    require(after.get('viewport')==before.get('viewport') and after.get('pageScroll')==before.get('pageScroll'),
            'manual-scroll-outer-context-changed')
    old,new=before['ancestors'],after.get('ancestors',[])
    require(len(old)==len(new),'manual-scroll-outer-context-changed')
    for index,(a,b) in enumerate(zip(old,new)):
        require(all(a.get(k)==b.get(k) for k in ['tag','rect','overflowX','overflowY','clientHeight','scrollHeight','clientWidth','scrollWidth','scrollLeft']),
                'manual-scroll-outer-context-changed')
        require(abs(b.get('scrollTop',-10000)-(plan['desired'] if index==0 else a['scrollTop']))<=1,
                'manual-scroll-target-not-reached' if index==0 else 'manual-scroll-outer-context-changed')
    visible=after.get('visible',{});target=after.get('target',{})
    def on_screen(r):
        return all(type(r.get(k)) in {int,float} for k in ['left','right','top','bottom']) and (
            r['left']>=visible['left']-1 and r['right']<=visible['right']+1
            and r['top']>=visible['top']-1 and r['bottom']<=visible['bottom']+1)
    require(visible==before['visible'] and on_screen(target) and after.get('targetCenterHits') is True,
            'manual-scroll-target-clipped-or-covered')
    controls=after.get('controls',[])
    require(len(controls)==3 and all(isinstance(c,dict) for c in controls)
            and [c.get('selector') for c in controls]==['input[type="number"]','button[type="submit"]','button[type="button"]'],
            'manual-scroll-controls-unavailable')
    require([(c['disabled'],c['value']) for c in controls]==[(c['disabled'],c['value']) for c in before['controls']],
            'manual-scroll-input-changed')
    if attempt['target']=='controls':
        require(all(on_screen(c['rect']) and c.get('centerHitsTarget') is True for c in controls)
                and controls[2].get('disabled') is False,'manual-scroll-controls-unreachable')


def validate_narrow_own_area_geometry(value):
    if not isinstance(value,dict): raise EvidenceFailure('manual-visual','manual-own-area-unavailable')
    viewport=value.get('viewport',{});r=value.get('rect',{})
    if (value.get('ownLabel') is not True or value.get('centerHitsTarget') is not True
        or not all(type(r.get(k)) in (int,float) and math.isfinite(r[k]) for k in ('left','top','right','bottom'))
        or not (0<=r['left']<r['right']<=viewport.get('width',0) and 0<=r['top']<r['bottom']<=viewport.get('height',0))):
        raise EvidenceFailure('manual-visual','manual-own-area-clipped-or-covered')


def validate_narrow_own_area(proof, require_resize=False):
    if not isinstance(proof,dict): raise EvidenceFailure('manual-visual','manual-own-area-proof-unavailable')
    validate_narrow_own_area_geometry(proof.get('before'))
    before=proof['before'];after=proof.get('after',{})
    if (proof.get('input_kind')!='native-click' or proof.get('click_count')!=1
        or proof.get('state_unchanged') is not True or before.get('selected') is not False or after.get('selected') is not True
        or after.get('inputValue')!=before.get('inputValue') or after.get('ownLabel') is not True
        or after.get('viewport')!=before.get('viewport')
        or not 360<=before.get('viewport',{}).get('width',0)<=500
        or (require_resize and proof.get('resize_ui_preserved') is not True)):
        raise EvidenceFailure('manual-visual','manual-own-area-native-selection-unproven')


def validate_manual_visual(report, source_text=None, source_only=False):
    validate_narrow_own_area(report.get('manual_narrow_own_area'), require_resize=True)
    observations = report.get('manual_visual')
    required = {'same-source', 'life19', 'life18', 'historical-lookup', 'registered-pending', 'manual-source-narrow'}
    if source_only: required={'same-source','manual-source-narrow'}
    if (not isinstance(observations, dict) or set(observations) != required
            or report.get('viewport_restored') is not True):
        raise EvidenceFailure('manual-visual', 'required-visual-observations-missing')
    for key,value in observations.items():
        validate_manual_visual_observation(value, require_visible=key=='manual-source-narrow')
        if source_text is not None and value['canonicalSourceText'] != source_text:
            raise EvidenceFailure('manual-visual','source-canonical-proof-mismatch')
    wide = observations['same-source'].get('viewport', {}).get('width')
    narrow = observations['manual-source-narrow'].get('viewport', {}).get('width')
    if type(wide) is not int or wide < 1400 or type(narrow) is not int or not 360 <= narrow <= 500:
        raise EvidenceFailure('manual-visual', 'wide-and-narrow-viewports-not-observed')
    scroll=report.get('manual_narrow_scroll')
    if not isinstance(scroll,list) or [item.get('target') for item in scroll] != ['source','controls']:
        raise EvidenceFailure('manual-visual','manual-scroll-proof-unavailable')
    for attempt in scroll: validate_manual_scroll(attempt)
    if scroll[0]['settled_after']['target']!=observations['manual-source-narrow']['source']:
        raise EvidenceFailure('manual-visual','manual-scroll-source-capture-mismatch')


def validate_source_text_positive(report, consumer, execution, source_text):
    def require(value,reason):
        if not value: raise EvidenceFailure('manual-visual',reason)
    require(report.get('scope')==MANUAL_SOURCE_TEXT_SCOPE and report.get('fixture')=='1c.B'
            and report.get('source_text_only') is True and report.get('status')=='passed'
            and report.get('consumer')==consumer and report.get('consumer_execution')==execution
            and report.get('primary')=={'stage':'operations-complete','code':0,'reason':'completed'}
            and report.get('secondary')==[], 'source-text-positive-provenance')
    require(source_text.get('oracle_text_kind')=='nonempty' and source_text.get('oracle_text_length',0)>0,
            'source-text-positive-requires-nonempty-oracle')
    for stage in ['prepayment','manual-options','manual-cast','initial']:
        require(report.get('stages',{}).get(stage)=={'status':'passed','assertions_completed':True},
                'source-text-positive-stage:'+stage)
    pre,paid,began=(report.get(key,{}) for key in ['prepayment','manual_paid_before_begin','begin'])
    source=pre.get('sourceCardId')
    require(type(source) is int and pre.get('sourceInHand') is True and pre.get('waitingType')=='Priority'
            and pre.get('priorityPlayer')==0 and pre.get('stackCount')==0 and pre.get('manualPhase') is None,
            'source-text-positive-prepayment')
    for state,mana in [(pre,2),(paid,1),(began,1)]:
        require(state.get('life')==[20,20] and state.get('ownManaCount')==mana,'source-text-positive-life-mana')
    require(paid.get('sourceId')==source and paid.get('manualPhase')=='armed'
            and paid.get('stackCount')==1 and paid.get('resolvingEntryId') is None,'source-text-positive-payment')
    require(began.get('sourceId')==source and began.get('manualPhase')=='open' and began.get('stackCount')==0
            and type(began.get('manualStackEntryId')) is int
            and began.get('resolvingEntryId')==began['manualStackEntryId'],'source-text-positive-carrier')
    events=began.get('publicEvents',{})
    require(events.get('lifeChanges')==[] and events.get('sourceDepartures')==0 and events.get('manualTerminals')==0,
            'source-text-positive-no-body-commit')
    require(report.get('prepayment_full_control') is True and report.get('prepayment_scope_visible') is True,
            'source-text-positive-manual-intent')
    commands=report.get('click_commands',[])
    expected={
        'prepayment-full-control':'[data-mobile-action-right] button[aria-label="Full Control Off"][aria-pressed="false"]',
        'manual-card-select':'[data-hand-card][data-object-id="'+str(source)+'"]',
        'manual-options':'//button[normalize-space()="Resolution options for P1 Self Loss"]',
        'manual-response':'//button[normalize-space()="Resolve"]',
        'manual-source-narrow':'[data-testid="player-area-0"] > button[aria-pressed]'}
    for stage,locator in expected.items():
        matches=[command for command in commands if command.get('operation')==stage]
        require(len(matches)==1 and matches[0].get('locator')==locator
                and matches[0].get('kind')=='native-element-click' and matches[0].get('status')=='completed',
                'source-text-positive-native:'+stage)
    cast=[command for command in commands if command.get('operation')=='manual-cast']
    require([command.get('locator') for command in cast] in
            [['//button[normalize-space()="Cast with manual resolution"]'],
             ['//button[normalize-space()="Cast with manual resolution"]','//button[normalize-space()="Pay"]']]
            and all(command.get('kind')=='native-element-click' and command.get('status')=='completed' for command in cast)
            and len(commands)==len(expected)+len(cast),'source-text-positive-native:manual-cast')
    drivers=report.get('fixture_opponent_drivers',[])
    require(len(drivers)==1,'source-text-positive-driver-count')
    driver=drivers[0];before=driver.get('before',{});after=driver.get('after',{})
    require(driver.get('ok') is True and driver.get('actor')==1 and driver.get('action')=='PassPriority'
            and driver.get('mode')=='explicit-local-fixture-opponent-driver' and driver.get('commands')==1
            and before.get('waitingType')=='Priority' and before.get('priorityPlayer')==1
            and all(before.get(key)==paid.get(key) for key in
                    ['life','ownManaCount','sourceId','manualPhase','stackCount','resolvingEntryId'])
            and all(after.get(key)==began.get(key) for key in
                    ['life','ownManaCount','sourceId','manualPhase','stackCount','manualStackEntryId','resolvingEntryId']),
            'source-text-positive-driver-boundary')
    require(report.get('receipt_observer_stopped') is True,'source-text-positive-observer-cleanup')
    validate_manual_visual(report,source_text=source_text,source_only=True)


def validate_operations(report, consumer, execution, paidplay=False, restore_driver=False, s1_1a=False, s1_1c=False, control=None, recorded_1c=False):
    """Require explicit operation completion; image receipts are observations."""
    def reject(reason):
        raise EvidenceFailure('operation-assertions', reason)
    if not isinstance(report, dict) or report.get('status') != 'passed':
        reject('operation-report-not-passed')
    if report.get('consumer') != consumer or report.get('consumer_execution') != execution:
        reject('operation-report-provenance-mismatch')
    primary = report.get('primary')
    if (not isinstance(primary, dict) or type(primary.get('code')) is not int
            or primary['code'] != 0 or primary.get('reason') != 'completed'
            or primary.get('stage') != 'operations-complete' or report.get('secondary') != []):
        reject('operation-primary-not-success')
    stages = report.get('stages')
    if not isinstance(stages, dict):
        reject('required-operation-stages-missing')
    required = (['control-initial','control-full-control','control-paid','control-response','control-completed'] if control else ['prepayment', 'manual-options', 'manual-cast', 'initial', 'life18', 'finish', 'paidplay21'] + (['life19','historical-lookup'] if s1_1c else []) if s1_1a or s1_1c else ['initial', 'life19', 'finish'] + (['paidplay22'] if paidplay else []) + (['checked-restore-k1', 'fixture-opponent-pass'] if restore_driver else []))
    for stage in required:
        item = stages.get(stage)
        if not isinstance(item, dict):
            reject('required-operation-stage-missing:' + stage)
        if item.get('status') != 'passed' or item.get('assertions_completed') is not True:
            reject('required-operation-stage-incomplete:' + stage)
    if control:
        validate_control_boundaries(report)
        if report.get('control_case') != control:
            reject('control-case-mismatch')
        return
    if recorded_1c:
        for stage in ['recorded-initial','recorded-main','recorded-ready','registered-pending']:
            if stages.get(stage)!={'status':'passed','assertions_completed':True}:reject('required-recorded-stage:'+stage)
        validate_recorded_1c(report)
        return
    if s1_1a or s1_1c:
        validate_s1_1a(report, split_apply=s1_1c)
    if s1_1c:
        validate_historical_lookup(report)
    if paidplay:
        paid = report.get('paid_before_resolution')
        if (not isinstance(paid, dict) or paid.get('life') != [19, 20]
                or type(paid.get('ownManaCount')) is not int or paid['ownManaCount'] != 0
                or type(paid.get('stackCount')) is not int or paid['stackCount'] != 1
                or paid.get('waitingType') != 'Priority' or paid.get('manualPhase') == 'open'
                or paid.get('resolvingEntryId', 'missing') is not None
                or paid.get('nextCardId', 'missing') is not None or paid.get('nextInGraveyard') is not False):
            reject('paid-before-resolution-incomplete')
    if restore_driver:
        if report.get('scope') != BOUNDED_K1_SCOPE:
            reject('bounded-k1-scope-mismatch')
        restore = report.get('checked_restore_k1')
        checks = restore.get('contextChecks') if isinstance(restore, dict) else None
        expected_checks = {'sameOwner', 'newSession', 'nextRestoreEpoch', 'nextAdapterGeneration'}
        if (not paidplay or not isinstance(restore, dict) or restore.get('ok') is not True
                or restore.get('method') != 'existing-live-export-and-authenticated-checked-restore'
                or not isinstance(checks, dict) or set(checks) != expected_checks
                or any(value is not True for value in checks.values())
                or not isinstance(restore.get('checkpoint_sha256'), str)
                or not re.fullmatch('[0-9a-f]{64}', restore['checkpoint_sha256'])):
            reject('checked-restore-k1-incomplete')
        before, after = restore.get('before'), restore.get('after')
        preserved = ['life', 'manualPhase', 'sourceId', 'sourceName', 'stackCount', 'manualStackEntryId',
                     'resolvingEntryId', 'waitingType', 'priorityPlayer', 'ownManaCount', 'nextCardId']
        if (not isinstance(before, dict) or not isinstance(after, dict)
                or before.get('life') != [20, 20] or before.get('manualPhase') != 'open'
                or type(before.get('sourceId')) is not int or type(before.get('manualStackEntryId')) is not int
                or before.get('resolvingEntryId') != before['manualStackEntryId']
                or type(before.get('stackCount')) is not int or before['stackCount'] != 0
                or type(before.get('ownManaCount')) is not int or before['ownManaCount'] != 1
                or type(before.get('nextCardId')) is not int
                or any(key not in before or key not in after or before[key] != after[key] for key in preserved)):
            reject('checked-restore-k1-public-occurrence-mismatch')
        driver = report.get('fixture_opponent_driver')
        if (not isinstance(driver, dict) or driver.get('ok') is not True
                or driver.get('mode') != 'explicit-local-fixture-opponent-driver'
                or driver.get('action') != 'PassPriority' or type(driver.get('actor')) is not int or driver['actor'] != 1
                or type(driver.get('commands')) is not int or driver['commands'] != 1
                or driver.get('opponent_ui') is not False or driver.get('two_client') is not False):
            reject('fixture-opponent-driver-incomplete')
        pending = driver.get('before')
        if (not isinstance(pending, dict) or pending.get('waitingType') != 'Priority'
                or type(pending.get('priorityPlayer')) is not int or pending['priorityPlayer'] != 1
                or type(pending.get('stackCount')) is not int or pending['stackCount'] != 1
                or type(pending.get('ownManaCount')) is not int or pending['ownManaCount'] != 0
                or pending.get('life') != [19, 20] or pending.get('manualPhase') == 'open'
                or pending.get('resolvingEntryId', 'missing') is not None
                or pending.get('nextCardId', 'missing') is not None or pending.get('nextInGraveyard') is not False):
            reject('fixture-opponent-driver-boundary-mismatch')


def validate_s1_1a(report, split_apply=False, recorded=False):
    def require(condition, reason):
        if not condition:
            raise EvidenceFailure('operation-assertions', ('s1-1c-' if split_apply else 's1-1a-') + reason)
    require(report.get('scope') == (RECORDED_1C_SCOPE if recorded else S1_1C_SCOPE if split_apply else S1_1A_SCOPE) and report.get('fixture') == ('1c.recorded.B' if recorded else '1c.B' if split_apply else '1a.B'), 'scope-fixture-mismatch')
    pre, paid, begin, life, end, next_paid, next_done = (report.get(k) for k in
        ['prepayment', 'manual_paid_before_begin', 'begin', 'life_applied', 'finished', 'paid_before_resolution', 'ordinary_completed'])
    require(all(isinstance(x, dict) for x in [pre, paid, begin, life, end, next_paid, next_done]), 'public-boundaries-missing')
    source, entry = pre.get('sourceCardId'), begin.get('manualStackEntryId')
    require(type(source) is int and type(entry) is int and type(pre.get('nextCardId')) is int, 'source-occurrence-missing')
    require(pre.get('sourceInHand') is True and pre.get('sourceInGraveyard') is False
        and pre.get('manualPhase') is None and pre.get('resolvingEntryId') is None
        and pre.get('stackCount') == 0 and pre.get('life') == [20,20] and pre.get('ownManaCount') == 2
        and pre.get('waitingType') == 'Priority' and pre.get('priorityPlayer') == 0, 'not-before-designation-payment')
    require(report.get('prepayment_scope_visible') is True and report.get('own_area_label') == 'You', 'real-scope-own-area-label-missing')
    require(paid.get('life') == [20,20] and paid.get('ownManaCount') == 1 and paid.get('stackCount') == 1
        and paid.get('manualPhase') == 'armed' and paid.get('sourceId') == source
        and paid.get('resolvingEntryId') is None and paid.get('waitingType') == 'Priority', 'manual-payment-boundary-mismatch')
    require(begin.get('life') == [20,20] and begin.get('ownManaCount') == 1 and begin.get('stackCount') == 0
        and begin.get('manualPhase') == 'open' and begin.get('sourceId') == source
        and begin.get('resolvingEntryId') == entry, 'begin-boundary-mismatch')
    require(life.get('life') == [18,20] and life.get('ownManaCount') == 1 and life.get('stackCount') == 0
        and life.get('manualPhase') == 'open' and life.get('sourceId') == source
        and life.get('manualStackEntryId') == entry and life.get('resolvingEntryId') == entry, 'apply-boundary-mismatch')
    require(finish_matches(begin, end, own_life=18) and end.get('sourceInGraveyard') is True
        and end.get('ownManaCount') == 1, 'finish-boundary-mismatch')
    require(next_paid.get('life') == [18,20] and next_paid.get('ownManaCount') == 0 and next_paid.get('stackCount') == 1
        and next_paid.get('manualPhase') == 'closed' and next_paid.get('resolvingEntryId') is None
        and next_paid.get('waitingType') == 'Priority' and next_paid.get('nextCardId', 'missing') is None
        and next_paid.get('nextInGraveyard') is False, 'ordinary-payment-boundary-mismatch')
    require(next_done.get('life') == [21,20] and next_done.get('ownManaCount') == 0 and next_done.get('stackCount') == 0
        and next_done.get('manualPhase') == 'closed' and next_done.get('resolvingEntryId') is None
        and next_done.get('waitingType') == 'Priority' and next_done.get('nextCardId', 'missing') is None
        and next_done.get('nextInGraveyard') is True, 'ordinary-completion-boundary-mismatch')
    drivers = report.get('fixture_opponent_drivers')
    require(isinstance(drivers, list) and len(drivers) == 2, 'fixture-driver-count')
    for driver, boundary, amount, mana, phase in zip(drivers, [paid, next_paid], [20,18], [1,0], ['armed','closed']):
        require(isinstance(driver, dict) and driver.get('ok') is True and driver.get('mode') == 'explicit-local-fixture-opponent-driver'
            and driver.get('action') == 'PassPriority' and type(driver.get('actor')) is int and driver['actor'] == 1
            and type(driver.get('commands')) is int and driver['commands'] == 1
            and driver.get('opponent_ui') is False and driver.get('two_client') is False, 'fixture-driver-invalid')
        b = driver.get('before')
        require(isinstance(b, dict) and b.get('life') == [amount,20] and b.get('ownManaCount') == mana
            and b.get('manualPhase') == phase and b.get('priorityPlayer') == 1 and b.get('waitingType') == 'Priority'
            and b.get('stackCount') == 1 and b.get('resolvingEntryId') is None
            and b.get('sourceId') == source and b.get('manualStackEntryId') == boundary.get('manualStackEntryId'), 'fixture-driver-boundary')
    losses = [{'amount':-1,'total':19},{'amount':-1,'total':18}] if split_apply else [{'amount':-2,'total':18}]
    for state, changes, departed, terminals, next_departed in [
        (pre, [], 0, 0, 0), (begin, [], 0, 0, 0),
        (life, losses,0,0,0), (end,losses,1,1,0),
        (next_done,losses+[{'amount':3,'total':21}],1,1,1)]:
        require(state.get('publicEvents') == {'lifeChanges':changes,'sourceDepartures':departed,
            'manualTerminals':terminals,'nextDepartures':next_departed}, 'event-boundary-mismatch')
    summary = report.get('receipt_summary')
    require(isinstance(summary, dict) and summary.get('appliedResults') == (4 if split_apply else 3), 'receipt-delivery-count')
    receipts = summary.get('completed')
    require(isinstance(receipts, list) and len(receipts) == (4 if split_apply else 3) and all(isinstance(r,dict) for r in receipts), 'receipt-count')
    cast_receipts = [r for r in receipts if r.get('stackEntryId', 'missing') is None]
    operation_receipts = [r for r in receipts if r.get('stackEntryId') == entry]
    require(len(cast_receipts) == 1 and len(operation_receipts) == (3 if split_apply else 2)
        and cast_receipts[0].get('sourceId') == source and cast_receipts[0].get('lifeChanges') == []
        and cast_receipts[0].get('terminalCount') == 0, 'cast-receipt-mismatch')
    require(all(r.get('sourceId') == source and r.get('stackEntryId') == entry for r in operation_receipts)
        and sorted(r.get('terminalCount', -1) for r in operation_receipts) == ([0,0,1] if split_apply else [0,1])
        and [e for r in operation_receipts for e in r.get('lifeChanges', [])] == losses, 'receipt-source-event-mismatch')
    require(report.get('prepayment_full_control') is True, 'full-control-not-confirmed')
    commands = report.get('click_commands', [])
    ordinary_clicks = [c for c in commands if c.get('operation') == 'paidplay-normal-direct']
    require(len(ordinary_clicks) == 1 and ordinary_clicks[0].get('native_double_click_verified') is True, 'trusted-double-click-missing')
    require(all(any(c.get('operation') == stage and c.get('status') == 'completed' for c in commands)
        for stage in ['prepayment-full-control','manual-card-select','manual-options','manual-cast','manual-response','player-area-select','life18','finish','paidplay-normal-direct','paidplay-response'] + (['life19'] if split_apply else [])), 'native-clicks-missing')



def validate_control_boundaries(report):
    def require(condition, reason):
        if not condition:
            raise EvidenceFailure('operation-assertions','auto-control-'+reason)
    case=report.get('control_case')
    if case=='auto-v':
        return validate_vanilla_control_boundaries(report)
    require(case in {'auto-s','auto-n'} and report.get('scope')==AUTO_CONTROLS_SCOPE and report.get('fixture')=='1a.B','scope-case-mismatch')
    initial, paid, done = (report.get(k) for k in ['control_initial','control_paid','control_completed'])
    require(all(isinstance(x,dict) for x in [initial,paid,done]),'boundaries-missing')
    source,next_card=initial.get('sourceCardId'),initial.get('nextCardId')
    require(type(source) is int and type(next_card) is int and source!=next_card,'source-missing')
    require(report.get('selected_card_id')==(source if case=='auto-s' else next_card),'wrong-card')
    for state,life,mana,stack in [(initial,20,2,0),(paid,20,1,1),(done,18 if case=='auto-s' else 23,1,0)]:
        require(state.get('life')==[life,20] and state.get('ownManaCount')==mana and state.get('stackCount')==stack
            and state.get('manualPhase','missing') is None and state.get('resolvingEntryId','missing') is None
            and state.get('manualStackEntryId','missing') is None and state.get('sourceId','missing') is None
            and state.get('waitingType')=='Priority' and state.get('sourceCardId')==source,'life-payment-carrier-mismatch')
    require(initial.get('priorityPlayer')==0 and initial.get('sourceInHand') is True
        and initial.get('sourceInGraveyard') is False,'not-fresh-initial')
    empty=dict(lifeChanges=[],sourceDepartures=0,manualTerminals=0,nextDepartures=0)
    require(initial.get('publicEvents')==empty and paid.get('publicEvents')==empty,'effect-before-resolution')
    require(done.get('sourceInHand') is (case=='auto-n') and done.get('sourceInGraveyard') is (case=='auto-s')
        and done.get('nextInGraveyard') is (case=='auto-n')
        and done.get('nextCardId')==(next_card if case=='auto-s' else None),'graveyard-hand-mismatch')
    require(done.get('publicEvents')==dict(lifeChanges=[{'amount':-2 if case=='auto-s' else 3,'total':18 if case=='auto-s' else 23}],
        sourceDepartures=1 if case=='auto-s' else 0,manualTerminals=0,nextDepartures=0 if case=='auto-s' else 1),'ordinary-effect-mismatch')
    require(report.get('control_on') is True,'full-control-missing')
    commands=report.get('click_commands',[])
    direct=[x for x in commands if x.get('operation')=='control-normal-direct']
    require(len(direct)==1 and direct[0].get('status')=='completed' and direct[0].get('native_double_click_verified') is True,'trusted-double-click-missing')
    require(all(any(c.get('operation')==stage and c.get('status')=='completed' for c in commands)
        for stage in ['control-full-control','control-normal-direct','control-response']),'native-control-missing')
    driver=report.get('fixture_opponent_driver')
    require(isinstance(driver,dict) and driver.get('ok') is True and driver.get('mode')=='explicit-local-fixture-opponent-driver'
        and driver.get('action')=='PassPriority' and type(driver.get('actor')) is int and driver['actor']==1
        and type(driver.get('commands')) is int and driver['commands']==1 and driver.get('opponent_ui') is False and driver.get('two_client') is False,'driver-invalid')
    before=driver.get('before')
    require(isinstance(before,dict) and before.get('priorityPlayer')==1 and before.get('life')==[20,20]
        and before.get('stackCount')==1 and before.get('ownManaCount')==1 and before.get('manualPhase','missing') is None
        and before.get('resolvingEntryId','missing') is None and before.get('publicEvents')==empty,'driver-boundary-mismatch')


def validate_vanilla_control_boundaries(report):
    def require(condition,reason):
        if not condition:
            raise EvidenceFailure('operation-assertions','auto-v-'+reason)
    require(report.get('control_case')=='auto-v' and report.get('scope')==AUTO_V_SCOPE and report.get('fixture')=='11c.V.B','scope-fixture')
    initial,paid,done=(report.get(k) for k in ['control_initial','control_paid','control_completed'])
    require(all(isinstance(x,dict) and isinstance(x.get('vanilla'),dict) for x in [initial,paid,done]),'boundaries-missing')
    selected=initial['vanilla'].get('id')
    require(type(selected) is int and report.get('selected_card_id')==selected and selected not in [initial.get('sourceCardId'),initial.get('nextCardId')],'wrong-card')
    for state,mana,stack,zone,casts,entries in [(initial,2,0,'Hand',0,0),(paid,1,1,'Stack',1,0),(done,1,0,'Battlefield',1,1)]:
        v=state['vanilla']
        require(state.get('life')==[20,20] and state.get('ownManaCount')==mana and state.get('stackCount')==stack and state.get('waitingType')=='Priority','life-payment-stack')
        require(all(state.get(k,'missing') is None for k in ['manualPhase','resolvingEntryId','manualStackEntryId','sourceId']),'manual-carrier')
        require(state.get('publicEvents')==dict(lifeChanges=[],sourceDepartures=0,manualTerminals=0,nextDepartures=0),'unrelated-effect')
        require(v.get('id')==selected and v.get('name')=='P1 Vanilla V' and v.get('zone')==zone and v.get('controller')==0 and type(v.get('controller')) is int,'card-zone-controller')
        require(v.get('inHand') is (zone=='Hand') and v.get('inBattlefield') is (zone=='Battlefield'),'zone-membership')
        require(type(v.get('power')) is int and v['power']==2 and type(v.get('toughness')) is int and v['toughness']==2
            and v.get('cost')==dict(type='Cost',shards=[],generic=1) and v.get('abilityCounts')==[0,0,0,0,0],'vanilla-definition')
        require(type(v.get('spellCasts')) is int and v['spellCasts']==casts and type(v.get('battlefieldEntries')) is int and v['battlefieldEntries']==entries
            and type(v.get('effects')) is int and v['effects']==0,'ordinary-events')
    require(initial.get('priorityPlayer')==0 and report.get('control_on') is True,'full-control')
    commands=report.get('click_commands',[])
    direct=[x for x in commands if x.get('operation')=='control-normal-direct']
    require(len(direct)==1 and direct[0].get('status')=='completed' and direct[0].get('native_double_click_verified') is True,'native-double-click')
    require(all(any(c.get('operation')==stage and c.get('status')=='completed' for c in commands) for stage in ['control-full-control','control-normal-direct','control-response']),'native-response')
    d=report.get('fixture_opponent_driver')
    require(isinstance(d,dict) and d.get('ok') is True and d.get('mode')=='explicit-local-fixture-opponent-driver' and d.get('action')=='PassPriority'
        and type(d.get('actor')) is int and d['actor']==1 and type(d.get('commands')) is int and d['commands']==1 and d.get('opponent_ui') is False and d.get('two_client') is False,'fixture-driver')
    before=d.get('before')
    require(isinstance(before,dict) and before.get('waitingType')=='Priority' and before.get('priorityPlayer')==1
        and before.get('life')==[20,20] and before.get('stackCount')==1 and before.get('ownManaCount')==1
        and all(before.get(k,'missing') is None for k in ['manualPhase','resolvingEntryId','manualStackEntryId','sourceId'])
        and before.get('publicEvents')==paid.get('publicEvents') and before.get('vanilla')==paid.get('vanilla'),'fixture-response-boundary')


def validate_historical_lookup(report, recorded=False):
    def require(condition, reason):
        if not condition:
            raise EvidenceFailure('operation-assertions', 's1-1c-' + reason)
    lookup, begin, first, life = (report.get(k) for k in ['historical_lookup','begin','life_first','life_applied'])
    require(all(isinstance(x,dict) for x in [lookup,begin,first,life]), 'historical-boundaries-missing')
    source, entry = begin.get('sourceId'), begin.get('manualStackEntryId')
    require(type(source) is int and type(entry) is int, 'lookup-source-missing')
    require(first.get('life') == [19,20] and first.get('sourceId') == source
        and first.get('manualStackEntryId') == entry and first.get('resolvingEntryId') == entry
        and first.get('manualPhase') == 'open' and first.get('stackCount') == 0 and first.get('ownManaCount') == 1
        and first.get('publicEvents') == dict(lifeChanges=[{'amount':-1,'total':19}],sourceDepartures=0,manualTerminals=0,nextDepartures=0), 'first-apply-mismatch')
    require(lookup.get('method') == ('actual-original-request-native-lookup-and-adapter-historical-publication' if recorded else 'native-read-only-original-lookup-and-client-terminal-cache-reconcile')
        and type(lookup.get('nativeLookupCount')) is int and lookup['nativeLookupCount'] == 1
        and lookup.get('adapterPublishedHistoricalReply') is recorded, 'lookup-method-mismatch')
    for flag in ['differentInteractions','differentAttempts','sameOriginal','sameOriginalResult','sameSource','sameContext',
                 'nativeAppliedResultNull','nativeRejectionNull','cacheOriginalBinding']:
        require(lookup.get(flag) is True, 'lookup-' + flag)
    require(lookup.get('nativeStatus') == 'completed' and lookup.get('cacheStatus') == 'completed'
        and lookup.get('historicalLifeChanges') == [{'amount':-1,'total':19}]
        and lookup.get('historicalTerminalCount') == 0, 'original-receipt-mismatch')
    require(lookup.get('currentLife') == [18,20] and lookup.get('currentSourceId') == source
        and lookup.get('currentEntryId') == entry and lookup.get('currentPhase') == 'open', 'latest-native-current-mismatch')
    require(lookup.get('before') == life and lookup.get('after') == life, 'ui-regressed-after-lookup')
    counts = lookup.get('countsBefore')
    require(isinstance(counts,dict) and set(counts) == {'publications','appliedResults','completed'}
        and all(type(v) is int for v in counts.values()) and counts['publications'] >= 3
        and counts['appliedResults'] == 3 and counts['completed'] == 3
        and (lookup.get('countsAfter') == dict(publications=7,appliedResults=3,completed=3) and counts==dict(publications=6,appliedResults=3,completed=3) if recorded else lookup.get('countsAfter') == counts), 'lookup-replayed-or-published')
    if recorded:
        require(all(lookup.get(k) is True for k in ['originalRequestRetained','originalRequestFrozen','publicationSameOriginal','publicationSameOriginalResult','publicationAppliedResultNull']) and lookup.get('publicationStatus')=='completed'
            and lookup.get('publicationHistoricalLife')==[{'amount':-1,'total':19}] and lookup.get('publicationCurrentLife')==[18,20], 'actual-historical-publication')
    # During the live journey cleanup happens in finally; final aggregate requires it.
    if report.get('status') == 'passed':
        require(report.get('receipt_observer_stopped') is True, 'receipt-observer-not-stopped')

def validate_native_original_checks(report, complete=True, final=False, recorded=False):
    def require(value, reason):
        if not value:
            raise EvidenceFailure('operation-assertions', 'native-original-' + reason)
    groups = report.get('native_original_checks')
    require(isinstance(groups, list) and len(groups) == (2 if complete else 1), 'phase-count')
    for index, group in enumerate(groups):
        require(isinstance(group, dict), 'phase-missing')
        phase, total, count = ('before-second',19,2) if index == 0 else ('after-second',18,3)
        boundary = report.get('life_first' if index == 0 else 'life_applied')
        require(isinstance(boundary,dict) and boundary.get('life') == [total,20]
            and group.get('before') == boundary and group.get('after') == boundary, 'current-state-changed')
        require(group.get('phase') == phase and group.get('method') == 'same-actual-UI-original-native-register-apply-lookup'
            and group.get('adapterPublishedHistoricalReply') is False and group.get('qL2PrecommitCustodyProven') is False, 'scope')
        expected_counts = dict(publications=count*2 if recorded else count,appliedResults=count,completed=count)
        require(group.get('countsBefore') == expected_counts and group.get('countsAfter') == expected_counts
            and all(type(v) is int for v in group['countsBefore'].values()), 'delivery-counts')
        hashes = group.get('hashesBefore')
        require(isinstance(hashes,dict) and set(hashes)=={'stateSha256','replaySha256','replayActions'}
            and all(isinstance(hashes[k],str) and re.fullmatch('[0-9a-f]{64}',hashes[k]) for k in ['stateSha256','replaySha256'])
            and type(hashes['replayActions']) is int and hashes['replayActions'] > 0
            and group.get('hashesAfter') == hashes, 'state-or-replay-changed')
        queries = group.get('queries')
        expected = [(subject,operation) for subject in (['qL1'] if index==0 else ['qL1','qL2'])
                    for operation in ['register','apply','lookup']]
        require(isinstance(queries,list) and len(queries)==len(expected), 'resend-count')
        for query,(subject,operation) in zip(queries,expected):
            require(isinstance(query,dict) and query.get('subject')==subject and query.get('operation')==operation
                and query.get('status')=='completed' and query.get('currentLife')==[total,20]
                and query.get('historicalLife')==[{'amount':-1,'total':19 if subject=='qL1' else 18}]
                and type(query.get('loseLifeEffects')) is int and query['loseLifeEffects']==1, 'original-result')
            require(all(query.get(k) is True for k in ['sameOriginal','sameOriginalResult','appliedResultNull','rejectionNull','sameSource']), 'original-binding')
        if index==0:
            refusal=group.get('refusals')
            require(isinstance(refusal,dict) and refusal.get('method')=='real-Worker-register-only-admission-and-old-interaction'
                and type(refusal.get('calls')) is int and refusal['calls']==2
                and type(refusal.get('actor')) is int and refusal['actor']==1, 'refusal-method')
            require(all(refusal.get(k) is True for k in ['admissionErrorMatched','freshInteractionDifferentFromOld','oldBindingNewAttempt',
                'separateNegativeAttempts','currentContextMatched','sameOriginal','resultNull','appliedResultNull','gameStateUnchanged']), 'refusal-not-certified')
            require(all(refusal.get(k) is False for k in ['admissionReceiptReturned','ledgerUnchangedClaim','refusalUi'])
                and refusal.get('rawOldStatus')=='notApplied' and refusal.get('oldRejection')=='invalid_interaction_response', 'refusal-classification')
            for prefix in ['actor','old']:
                require(refusal.get(prefix+'After')==boundary and refusal.get(prefix+'CountsAfter')==expected_counts
                    and refusal.get(prefix+'HashesAfter')==hashes, 'refusal-atomicity')
        else:
            require('refusals' not in group, 'unexpected-extra-refusal')
    if final:
        replay=report.get('native_final_replay')
        require(isinstance(replay,dict) and replay.get('method')=='real-Worker-read-only-replay'
            and isinstance(replay.get('sha256'),str) and re.fullmatch('[0-9a-f]{64}',replay['sha256'])
            and type(replay.get('actions')) is int and replay['actions']>0
            and type(replay.get('manualLife')) is int and replay['manualLife']==2
            and type(replay.get('manualFinish')) is int and replay['manualFinish']==1, 'final-manual-replay-counts')


def validate_additional_native_checks(report, complete=True):
    def require(ok, reason):
        if not ok: raise EvidenceFailure('operation-assertions','additional-native-'+reason)
    groups=report.get('additional_native_checks')
    expected=[('begin20','begin',20),('life19','life_first',19),('life18','life_applied',18),('closed18','finished',18)]
    require(isinstance(groups,list) and 1<=len(groups)<=4 and (not complete or len(groups)==4),'phase-count')
    variants=['amount-zero','amount-overflow','source-N','mismatched-generation','wrong-Finish-choice','old-interaction']
    for g,(phase,boundary,total) in zip(groups,expected):
        require(isinstance(g,dict) and g.get('status')=='passed' and g.get('currentReadMethod')=='authenticated-Worker-readLocalCurrent' and g.get('readOnlyFrameInvariant') is True and g.get('method')=='actual-Worker-finite-S5-and-qF-originals' and g.get('phase')==phase,'scope')
        before=report.get(boundary);require(isinstance(before,dict) and before.get('life')==[total,20] and g.get('before')==before,'boundary')
        require(all(g.get(k) is False for k in ['ledgerUnchangedClaim','refusalUi','oldGenerationProven','engineInFlightProven']),'overclaim')
        hashes=g.get('hashesBefore');counts=g.get('countsBefore')
        require(isinstance(hashes,dict) and set(hashes)=={'stateSha256','replaySha256','replayActions'} and all(isinstance(hashes[k],str) and re.fullmatch('[0-9a-f]{64}',hashes[k]) for k in ['stateSha256','replaySha256']) and type(hashes['replayActions']) is int and hashes['replayActions']>0,'hashes')
        count={'begin20':1,'life19':2,'life18':3,'closed18':4}[phase]
        pubs={'begin20':2,'life19':4,'life18':6,'closed18':9}[phase]
        # qL1 historical adapter publication adds one before Finish.
        require(counts=={'publications':pubs,'appliedResults':count,'completed':count},'counts')
        rows=g.get('rows');names=['qF-register','qF-apply','qF-lookup','old-Finish-new-attempt'] if phase=='closed18' else variants
        require(isinstance(rows,list) and len(rows)==len(names),'row-count')
        for row,name in zip(rows,names):
            require(isinstance(row,dict) and row.get('variant')==name and row.get('after')==before and row.get('countsAfter')==counts and row.get('hashesAfter')==hashes,'invariant')
            require(row.get('appliedResultNull') is True,'applied-result')
            if name.startswith('qF-'):
                require(row.get('operation')==name[3:] and row.get('status')=='completed' and all(row.get(k) is True for k in ['sameOriginal','sameOriginalResult','resultPresent']),'original-Finish')
            else:
                code='stale_interaction' if name=='mismatched-generation' else 'invalid_interaction_response'
                require(row.get('operation')=='register' and row.get('status')=='notApplied' and row.get('rejection')==code and row.get('resultNull') is True and row.get('separateAttempt') is True,'refusal')
                if phase=='closed18':require(row.get('sameCapturedIntent') is True,'old-Finish')
                else:require(row.get('sameOriginal') is True and row.get('oneFieldChange') is True and row.get('layer')==('native-current-context' if name=='mismatched-generation' else 'native-typed-source-interaction'),'typed-refusal')

def validate_recorded_pending(report):
    def require(ok, reason):
        if not ok: raise EvidenceFailure('operation-assertions','recorded-pending-'+reason)
    pending=report.get('registered_pending');first=report.get('life_first')
    require(isinstance(pending,dict) and isinstance(first,dict),'missing')
    require(pending.get('method')=='actual-registered-pending-before-apply-native-register-lookup'
        and pending.get('engineInFlight') is False,'scope')
    require(pending.get('before')==first and pending.get('after')==first,'resident-changed')
    require(pending.get('countsBefore')==dict(publications=5,appliedResults=2,completed=2)
        and pending.get('countsAfter')==pending['countsBefore'],'publication-changed')
    hashes=pending.get('hashesBefore')
    require(isinstance(hashes,dict) and set(hashes)=={'stateSha256','replaySha256','replayActions'}
        and all(isinstance(hashes[k],str) and re.fullmatch('[0-9a-f]{64}',hashes[k]) for k in ['stateSha256','replaySha256'])
        and type(hashes['replayActions']) is int and hashes['replayActions']>0
        and pending.get('hashesAfter')==hashes,'state-replay-changed')
    require(all(pending.get(k) is True for k in ['originalRequestRetained','originalRequestFrozen','oneShotClaimed','pendingResultNull','pendingAppliedResultNull']),'custody')
    queries=pending.get('queries')
    require(isinstance(queries,list) and len(queries)==2,'queries')
    for query,operation in zip(queries,['register','lookup']):
        require(isinstance(query,dict) and query.get('operation')==operation and query.get('status')=='pending'
            and query.get('currentLife')==[19,20]
            and all(query.get(k) is True for k in ['sameOriginal','resultNull','rejectionNull','appliedResultNull']),'native-query')


def validate_recorded_1c(report, final=True):
    if final: validate_additional_native_checks(report)
    if report.get('scope')!=RECORDED_1C_SCOPE or report.get('fixture')!='1c.recorded.B':
        raise EvidenceFailure('operation-assertions','recorded-1c-scope')
    if final:validate_recorded_prep(report,journey=True)
    validate_s1_1a(report,split_apply=True,recorded=True)
    validate_native_original_checks(report,final=True,recorded=True)
    validate_historical_lookup(report,recorded=True)
    validate_recorded_pending(report)
    if report.get('receipt_summary',{}).get('publications')!=9:
        raise EvidenceFailure('operation-assertions','recorded-1c-final-publication-count')
    if report.get('pending_hold_released') is not True or (final and report.get('receipt_observer_stopped') is not True):
        raise EvidenceFailure('operation-assertions','recorded-1c-cleanup')


def valid_png(data):
    """Check saved PNG chunks/CRC and compressed pixels with the stdlib."""
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return False
    offset, chunks, compressed = 8, [], bytearray()
    while offset + 12 <= len(data):
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        end = offset + 12 + length
        if end > len(data):
            return False
        kind, content = data[offset + 4:offset + 8], data[offset + 8:end - 4]
        if zlib.crc32(kind + content) != struct.unpack('>I', data[end - 4:end])[0]:
            return False
        if not chunks and (kind != b'IHDR' or length != 13
                or not all(struct.unpack('>II', content[:8]))):
            return False
        if kind == b'IHDR':
            if chunks:
                return False
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', content)
            # Chromium screenshots use non-interlaced RGB/RGBA, eight bits.
            if depth != 8 or color not in {2, 6} or (compression, filtering, interlace) != (0, 0, 0):
                return False
            row_bytes = 1 + width * (3 if color == 2 else 4)
            pixel_bytes = row_bytes * height
            if pixel_bytes > 32 * 1024 * 1024:
                return False
        chunks.append(kind)
        if kind == b'IDAT':
            compressed.extend(content)
        offset = end
        if kind == b'IEND':
            if length != 0 or offset != len(data) or not compressed:
                return False
            try:
                decoder = zlib.decompressobj()
                pixels = decoder.decompress(compressed, pixel_bytes + 1)
                return (len(pixels) == pixel_bytes and decoder.eof and not decoder.unused_data
                        and all(pixels[row * row_bytes] <= 4 for row in range(height)))
            except zlib.error:
                return False
    return False


def finish_matches(initial, ended, own_life=19):
    """Begin already popped this occurrence; Finish releases its carrier.

    Ordinary stack entries, whether zero or nonzero, are not the resolving
    entry. Require its exact public identity to disappear without popping them.
    """
    entry = initial.get('manualStackEntryId')
    count = initial.get('stackCount')
    return (initial.get('manualPhase') == 'open' and type(entry) is int
            and initial.get('resolvingEntryId') == entry
            and type(count) is int and count >= 0
            and ended.get('manualPhase') == 'closed' and ended.get('waitingType') == 'Priority'
            and ended.get('life', [])[:1] == [own_life]
            and ended.get('sourceId') == initial.get('sourceId')
            and ended.get('manualStackEntryId') == entry
            and 'resolvingEntryId' in ended and ended['resolvingEntryId'] is None
            and type(ended.get('stackCount')) is int and ended['stackCount'] == count)


def validate_recorded_operations(report, consumer, execution):
    if (report.get('status') != 'passed' or report.get('consumer') != consumer
            or report.get('consumer_execution') != execution
            or report.get('primary') != {'stage':'operations-complete','code':0,'reason':'completed'}
            or report.get('secondary') != []):
        raise EvidenceFailure('operation-assertions', 'recorded-operation-provenance-or-completion')
    for stage in ['recorded-initial','recorded-main','recorded-ready']:
        value = report.get('stages', {}).get(stage, {})
        if value.get('status') != 'passed' or value.get('assertions_completed') is not True:
            raise EvidenceFailure('operation-assertions', 'recorded-stage-incomplete:'+stage)
    validate_recorded_prep(report)


def validate_recorded_prep(report, journey=False):
    def require(value, reason):
        if not value: raise EvidenceFailure('recorded-start-preparation', reason)
    require(report.get('scope') == (RECORDED_1C_SCOPE if journey else 'recorded-start-preparation-only') and report.get('fixture') == '1c.recorded.B', 'scope')
    ready=report.get('recorded_ready') or {}
    require(ready.get('life') == [20,20] and ready.get('ownManaCount') == 2
        and ready.get('phase') == 'PreCombatMain' and ready.get('activePlayer') == 0
        and ready.get('waitingType') == 'Priority' and ready.get('priorityPlayer') == 0
        and ready.get('stackCount') == 0 and ready.get('manualPhase') is None
        and ready.get('resolvingEntryId') is None and ready.get('manualStackEntryId') is None, 'ordinary-ready-state')
    ids=ready.get('selectedIds') or {};land=ready.get('land') or {}
    require(set(ids)=={'source','next','land'} and all(type(x) is int for x in ids.values())
        and len(set(ids.values()))==3 and ready.get('sourceCardId')==ids['source'] and ready.get('sourceInHand') is True and ready.get('nextCardId')==ids['next']
        and land.get('id')==ids['land'] and land.get('zone')=='Battlefield' and land.get('controller')==0
        and land.get('tapped') is True and land.get('inHand') is False and land.get('inBattlefield') is True, 'selected-cards')
    require(ready.get('publicEvents')==dict(lifeChanges=[],sourceDepartures=0,manualTerminals=0,nextDepartures=0),'premature-effect')
    initial,main,landed=(report.get(key) for key in ['recorded_initial','recorded_main','land_mana_before'])
    require(all(isinstance(x,dict) for x in [initial,main,landed]),'prep-boundaries')
    for state in [initial,main,landed]:
        require(state.get('life')==[20,20] and state.get('ownManaCount')==0 and state.get('stackCount')==0
            and state.get('manualPhase') is None and state.get('resolvingEntryId') is None
            and state.get('manualStackEntryId') is None and state.get('selectedIds')==ids
            and state.get('sourceCardId')==ids['source'] and state.get('sourceInHand') is True
            and state.get('nextCardId')==ids['next'] and state.get('publicEvents')==ready['publicEvents'],'prep-boundary')
    require(initial.get('waitingType')=='MulliganDecision' and 0 in initial.get('mulliganPlayers',[]) and 1 in initial.get('mulliganPlayers',[]),'initial-mulligan')
    for state in [initial,main]:
        land=state.get('land') or {}
        require(land.get('id')==ids['land'] and land.get('zone')=='Hand' and land.get('inHand') is True
            and land.get('inBattlefield') is False and land.get('tapped') is False and land.get('controller')==0,'land-before-play')
    require(main.get('phase')=='PreCombatMain' and main.get('activePlayer')==0
        and main.get('waitingType')=='Priority' and main.get('priorityPlayer')==0
        and 'PlayLand' in main['land'].get('legalActionTypes',[]),'main-before-play')
    require(landed.get('phase')=='PreCombatMain' and landed.get('activePlayer')==0
        and landed.get('waitingType')=='Priority' and landed.get('priorityPlayer')==0
        and landed['land'].get('id')==ids['land'] and landed['land'].get('zone')=='Battlefield'
        and landed['land'].get('controller')==0 and landed['land'].get('tapped') is False
        and landed['land'].get('inBattlefield') is True and landed['land'].get('inHand') is False
        and any(t in landed['land'].get('legalActionTypes',[]) for t in ['ActivateManaSource','TapLandForMana']),'land-before-mana')
    recording=report.get('recording') or {}
    require(recording.get('available') is True and type(recording.get('replayActions')) is int
        and recording['replayActions']>0 and isinstance(recording.get('replaySha256'),str)
        and re.fullmatch('[0-9a-f]{64}',recording['replaySha256']), 'recording')
    require(type(report.get('prep_steps')) is int and 3<=report['prep_steps']<=20,'step-bound')
    drivers=report.get('prep_opponent_drivers')
    require(isinstance(drivers,list) and all(d.get('ok') is True and d.get('actor')==1 and type(d.get('commands')) is int
        and d['commands']==1 and d.get('action') in ['MulliganDecision','PassPriority']
        and d.get('opponent_ui') is False and d.get('two_client') is False for d in drivers),'opponent-driver')
    require(sum(d.get('action')=='MulliganDecision' for d in drivers)==1,'missing-or-duplicate-B-keep')
    for driver in drivers:
        before=driver.get('before') or {};after=driver.get('after') or {}
        for state in [before,after]:
            require(state.get('life')==[20,20] and state.get('ownManaCount')==0 and state.get('stackCount')==0
                and state.get('manualPhase') is None and state.get('resolvingEntryId') is None
                and state.get('selectedIds')==ids,'driver-boundary')
        require((driver['action']=='MulliganDecision' and before.get('waitingType')=='MulliganDecision'
            and 1 in before.get('mulliganPlayers',[])) or (driver['action']=='PassPriority'
            and before.get('waitingType')=='Priority' and before.get('priorityPlayer')==1),'driver-before')
    advances=report.get('prep_own_advances', [])
    require(isinstance(advances,list),'own-advance-checks')
    for advance in advances:
        before=advance.get('before') or {}
        require(before.get('waitingType')=='Priority' and before.get('activePlayer')==0
            and before.get('life')==[20,20] and before.get('ownManaCount')==0 and before.get('stackCount')==0
            and before.get('manualPhase') is None and before.get('resolvingEntryId') is None,'own-advance-boundary')
        status=advance.get('status')
        require((status=='priority-switched' and before.get('priorityPlayer')==1)
            or (status=='main-ready' and before.get('priorityPlayer')==0 and before.get('phase')=='PreCombatMain')
            or (status=='native-click' and before.get('priorityPlayer')==0 and before.get('phase')!='PreCombatMain'),'own-advance-eligibility')
    require(sum(a.get('status')=='native-click' for a in advances)==sum(c.get('operation')=='recorded-own-advance' and c.get('status')=='completed' for c in report.get('click_commands',[])),'own-advance-click-count')
    commands=report.get('click_commands') or []
    for operation,kind in [('recorded-own-keep','native-element-click'),('recorded-land-play','native-pointer-double-click'),('recorded-land-mana','native-element-click')]:
        matches=[c for c in commands if c.get('operation')==operation]
        require(len(matches)==1 and matches[0].get('status')=='completed' and matches[0].get('kind')==kind,'native-input:'+operation)
        if operation=='recorded-land-play':require(matches[0].get('native_double_click_verified') is True,'unverified-land-double-click')


def validate_required_images(root, manifest, execution, paidplay=False, s1_1a=False, s1_1c=False, control=None, recorded_prep=False, recorded_1c=False, manual_visual=False, source_text_only=False):
    """Recheck the three existing capture receipts and saved public bytes."""
    def reject(reason):
        raise EvidenceFailure('required-images', reason)
    try:
        steps = json.loads((root / 'step-index.json').read_text())
    except (OSError, ValueError):
        reject('required-image-index-unreadable')
    if not isinstance(steps, list) or any(not isinstance(item, dict) for item in steps) or (recorded_prep and len(steps)!=3):
        reject('required-image-index-invalid')
    observations = {}
    required = ['recorded-initial','recorded-main','recorded-ready'] if recorded_prep else ['control-initial','control-completed'] if control else ['prepayment','same-source','life18','finish','paidplay21'] + (['life19','historical-lookup'] if s1_1c else []) if s1_1a or s1_1c else ['same-source', 'life19', 'finish'] + (['paidplay22'] if paidplay else [])
    if recorded_1c: required=['recorded-initial','recorded-main','recorded-ready','registered-pending']+required
    if manual_visual: required += ['manual-source-narrow','manual-controls-narrow']
    if source_text_only: required=['prepayment','same-source','manual-source-narrow','manual-controls-narrow']
    for step in required:
        matches = [item for item in steps if item.get('step') == step]
        if len(matches) != 1:
            reject('required-image-count:' + step)
        item = matches[0]
        if (item.get('status') != 'observation-only' or type(item.get('exit_code')) is not int
                or item['exit_code'] != 0):
            reject('required-image-receipt-invalid:' + step)
        if (item.get('runtime') != manifest['runtime'] or item.get('consumer') != manifest['consumer']
                or item.get('validation') != manifest['validation']
                or item.get('consumer_execution') != execution
                or not isinstance(item.get('served'), dict)
                or item['served'].get('engine_wasm_bg.wasm')
                    != manifest['artifacts']['engine_wasm_bg.wasm']['sha256']):
            reject('required-image-provenance-mismatch:' + step)
        for kind, relative in [('screenshot', 'screenshots/' + step + '.png'),
                               ('state', 'states/' + step + '.json')]:
            receipt = item.get(kind)
            if not isinstance(receipt, dict) or receipt.get('path') != relative:
                reject('required-' + kind + '-receipt-invalid:' + step)
            try:
                data = (root / relative).read_bytes()
            except OSError:
                reject('required-' + kind + '-missing:' + step)
            if not data:
                reject('required-' + kind + '-empty:' + step)
            if hashlib.sha256(data).hexdigest() != receipt.get('sha256'):
                reject('required-' + kind + '-hash-mismatch:' + step)
            if kind == 'screenshot' and not valid_png(data):
                reject('required-screenshot-invalid-png:' + step)
            if kind == 'state':
                try:
                    state = json.loads(data)
                except ValueError:
                    reject('required-state-invalid:' + step)
                if (not isinstance(state, dict) or not isinstance(state.get('life'), list)
                        or len(state['life']) != 2 or any(type(life) is not int for life in state['life'])
                        or type(state.get('stackCount')) is not int or state['stackCount'] < 0
                        or any(key not in state or (state[key] is not None and type(state[key]) is not int)
                               for key in ['manualStackEntryId', 'resolvingEntryId'])
                        or (state.get('manualPhase') is not None and not isinstance(state['manualPhase'], str))
                        or state.get('manualPhase') not in {'open', 'closed', None}
                        or 'manualPhase' not in state or 'sourceId' not in state
                        or (state['sourceId'] is not None and type(state['sourceId']) is not int)
                        or 'sourceName' not in state or 'waitingType' not in state
                        or (state['sourceName'] is not None and not isinstance(state['sourceName'], str))
                        or (state['waitingType'] is not None and not isinstance(state['waitingType'], str))):
                    reject('required-state-invalid:' + step)
                observations[step] = state
    if recorded_prep:
        report=json.loads((root/'ui-smoke-report.json').read_text())
        validate_recorded_prep(report)
        for step,key in [('recorded-initial','recorded_initial'),('recorded-main','recorded_main'),('recorded-ready','recorded_ready')]:
            if observations[step]!=report.get(key): reject('required-recorded-state-content-mismatch:'+step)
        return {'required_steps':required,'verified_count':len(required)}
    if source_text_only:
        report=json.loads((root/'ui-smoke-report.json').read_text())
        validate_source_text_positive(report,manifest['consumer'],execution,report.get('canonical_source_text',{}))
        for step,key in [('prepayment','prepayment'),('same-source','begin'),('manual-source-narrow','begin'),('manual-controls-narrow','begin')]:
            if observations[step]!=report.get(key):reject('required-source-text-state-mismatch:'+step)
        return {'required_steps':required,'verified_count':len(required)}
    if control:
        report=json.loads((root/'ui-smoke-report.json').read_text())
        validate_control_boundaries(report)
        if report.get('control_case')!=control or observations['control-initial']!=report['control_initial'] or observations['control-completed']!=report['control_completed']:
            reject('required-control-state-content-mismatch')
        return {'required_steps':required,'verified_count':len(required)}
    if recorded_1c:
        report=json.loads((root/'ui-smoke-report.json').read_text());validate_recorded_1c(report)
        if manual_visual:
            validate_manual_visual(report)
            if any(observations[key] != report.get('begin') for key in ['manual-source-narrow','manual-controls-narrow']):
                reject('required-narrow-state-content-mismatch')
        for step,key in [('recorded-initial','recorded_initial'),('recorded-main','recorded_main'),('recorded-ready','recorded_ready')]:
            if observations[step]!=report.get(key):reject('required-recorded-state-content-mismatch:'+step)
        if observations['registered-pending']!=report.get('life_first'):reject('required-pending-state-content-mismatch')
    if s1_1c:
        first, current = observations['life19'], observations['life18']
        if (first.get('life') != [19,20] or first.get('manualPhase') != 'open'
                or any(first.get(k) != current.get(k) for k in ['sourceId','manualStackEntryId','resolvingEntryId','stackCount','ownManaCount'])
                or observations['historical-lookup'] != current):
            reject('required-state-content-mismatch:historical-lookup')
    own_life = 18 if s1_1a or s1_1c else 19
    initial, life, finish = (observations[step] for step in ['same-source', 'life18' if s1_1a or s1_1c else 'life19', 'finish'])
    if s1_1a or s1_1c:
        pre = observations['prepayment']
        if (pre['life'] != [20,20] or pre['manualPhase'] is not None or pre['stackCount'] != 0
                or pre['resolvingEntryId'] is not None or pre.get('ownManaCount') != 2
                or pre.get('sourceInHand') is not True or pre.get('sourceCardId') != initial['sourceId']):
            reject('required-state-content-mismatch:prepayment')
    if (initial['life'][0] != 20 or initial['manualPhase'] != 'open' or initial['sourceId'] is None
            or type(initial['manualStackEntryId']) is not int
            or initial['resolvingEntryId'] != initial['manualStackEntryId']):
        reject('required-state-content-mismatch:same-source')
    if (life['life'][0] != own_life or life['manualPhase'] != 'open' or life['sourceId'] != initial['sourceId']
            or life['manualStackEntryId'] != initial['manualStackEntryId']
            or life['resolvingEntryId'] != initial['manualStackEntryId']
            or life['stackCount'] != initial['stackCount']):
        reject('required-state-content-mismatch:life19')
    if not finish_matches(initial, finish, own_life=own_life):
        reject('required-state-content-mismatch:finish')
    if paidplay or s1_1a or s1_1c:
        next_play = observations['paidplay21' if s1_1a or s1_1c else 'paidplay22']
        if (type(finish.get('ownManaCount')) is not int or finish['ownManaCount'] != 1
                or type(finish.get('nextCardId')) is not int or finish.get('nextInGraveyard') is not False
                or next_play['life'] != [21 if s1_1a or s1_1c else 22, initial['life'][1]]
                or next_play['stackCount'] != 0 or next_play['waitingType'] != 'Priority'
                or next_play['manualPhase'] == 'open' or next_play['resolvingEntryId'] is not None
                or type(next_play.get('ownManaCount')) is not int or next_play['ownManaCount'] != 0
                or next_play.get('nextCardId', 'missing') is not None
                or next_play.get('nextInGraveyard') is not True):
            reject('required-state-content-mismatch:paidplay22')
    return {'required_steps': required, 'verified_count': len(required)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--step', required=True)
    parser.add_argument('--state-script', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'(manual-source-narrow|manual-controls-narrow|registered-pending|recorded-initial|recorded-main|recorded-ready|control-initial|control-completed|prepayment|same-source|life19|life18|historical-lookup|finish|child|paidplay21|paidplay22|restore-k[0-4]|ack-(life|finish)-(applied|rejected|unknown|inflight))', args.step):
        raise ValueError('unknown P1 observation step')
    session = os.environ['P1_WEBDRIVER_SESSION']
    if not re.fullmatch('[a-zA-Z0-9-]+', session):
        raise ValueError('invalid session')
    root = args.evidence.resolve()
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest['status'] != 'built':
        raise ValueError('new candidate runtime has not been built')
    installed = json.loads((root / 'consumer-install.json').read_text())
    if installed['consumer'] != manifest['consumer'] or installed['exit_code'] != 0:
        raise ValueError('consumer installation evidence missing')
    runtime_artifacts = {name: item for name, item in manifest['artifacts'].items()
                         if name.endswith(('.js', '.wasm'))}
    if installed.get('installed_artifacts') != runtime_artifacts:
        raise ValueError('incomplete executable runtime installation')
    boot_path = Path(os.environ['P1_BROWSER_BOOT'])
    boot = json.loads(boot_path.read_text())
    source = Path(os.environ['P1_CONSUMER_SOURCE']).resolve()
    if (boot['status'] != 'fresh-product-session' or not boot['fresh_session_after_install']
            or boot['session_sha256'] != hashlib.sha256(session.encode()).hexdigest()
            or boot['consumer'] != manifest['consumer'] or boot['consumer_source'] != str(source)
            or boot['manifest_sha256'] != hashlib.sha256((root / 'manifest.json').read_bytes()).hexdigest()
            or Path('/proc/' + str(boot['vite_pid']) + '/cwd').resolve() != source):
        raise ValueError('fresh candidate browser boot proof missing')
    def check_source():
        import subprocess
        def git(*argv):
            return subprocess.check_output(['git', '-C', str(source), *argv], text=True).strip()
        if git('status', '--porcelain') or {'sha': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}')} != manifest['consumer']:
            raise ValueError('consumer source changed')
        for name, item in runtime_artifacts.items():
            if hashlib.sha256((source / 'client/src/wasm' / name).read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('installed runtime changed')
    check_source()
    target = root / 'screenshots' / (args.step + '.png')
    state = root / 'states' / (args.step + '.json')
    if target.exists() or state.exists():
        raise ValueError('do not overwrite an observation')

    def call(endpoint, data=None):
        request = urllib.request.Request('http://127.0.0.1:9515/session/' + session + endpoint,
                                         data=json.dumps(data).encode() if data is not None else None,
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=60) as response:
            value = json.load(response)['value']
        if isinstance(value, dict) and 'error' in value:
            raise ValueError('WebDriver failed')
        return value

    route = call('/url')
    if not re.fullmatch(r'http://127\.0\.0\.1:5173/game/[^/?#]+(?:[?#].*)?', route):
        raise ValueError('capture requires the product /game/:id route')
    # Verify both installed and actually served WASM. Vite transforms glue, so
    # save its served hash separately, as V0 does, rather than claiming equality.
    served = {}
    for name in ['engine_wasm.js', 'engine_wasm_bg.wasm']:
        path = '/src/wasm/' + name
        with urllib.request.urlopen('http://127.0.0.1:5173' + path, timeout=60) as response:
            served[name] = hashlib.sha256(response.read()).hexdigest()
    if served['engine_wasm_bg.wasm'] != manifest['artifacts']['engine_wasm_bg.wasm']['sha256']:
        raise ValueError('served runtime does not match the new candidate')
    script = args.state_script.read_text()
    observation = call('/execute/sync', {'script': script, 'args': []})
    pixels = base64.b64decode(call('/screenshot'), validate=True)
    if not pixels.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('invalid screenshot')
    check_source()
    target.parent.mkdir(parents=True, exist_ok=True)
    state.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(pixels)
    state.write_text(json.dumps(observation, ensure_ascii=False, indent=2) + '\n')
    index = root / 'step-index.json'
    steps = json.loads(index.read_text()) if index.exists() else []
    steps.append({'step': args.step, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'route': route, 'runtime': manifest['runtime'], 'consumer': manifest['consumer'],
                  'validation': manifest['validation'], 'served': served,
                  'consumer_execution': boot['consumer_execution'],
                  'state_script_sha256': hashlib.sha256(script.encode()).hexdigest(),
                  'screenshot': {'path': str(target.relative_to(root)), 'sha256': hashlib.sha256(pixels).hexdigest()},
                  'state': {'path': str(state.relative_to(root)), 'sha256': hashlib.sha256(state.read_bytes()).hexdigest()},
                  'status': 'observation-only', 'exit_code': 0})
    index.write_text(json.dumps(steps, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Raw W3C replies/session identifiers are never logged (V0). Keep the
        # original failure class and nonzero exit, not transport/application text.
        import sys
        failure = {'status': 'capture-failed', 'error': type(error).__name__, 'exit_code': 1}
        try:
            failed_root = Path(sys.argv[sys.argv.index('--evidence') + 1]).resolve()
            failed_step = sys.argv[sys.argv.index('--step') + 1]
            if re.fullmatch('[a-z0-9-]+', failed_step) and failed_root.is_dir():
                failure['step'] = failed_step
                failure_path = failed_root / ('capture-failure-' + failed_step + '.json')
                with failure_path.open('x') as output:
                    output.write(json.dumps(failure) + '\n')
        except (ValueError, IndexError, OSError):
            pass
        print(json.dumps(failure))
        raise SystemExit(1)
