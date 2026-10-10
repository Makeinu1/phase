"""Reject unsafe evidence classifications; synthetic fixtures are not W/UI proof."""
import copy
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('capture_lookup',Path(__file__).with_name('p1-product-capture.py'))
capture=importlib.util.module_from_spec(spec);spec.loader.exec_module(capture)

def fixture():
    hashes={'stateSha256':'a'*64,'replaySha256':'b'*64,'replayActions':7};counts={'publications':6,'appliedResults':3,'completed':3}
    common={'stateReplayPublicCountsUnchanged':True,'hashesAfter':hashes,'countsAfter':counts,'publicStateSha256After':'c'*64}
    owner={'status':'completed','sameOriginalResult':True,'currentMatchesAuthenticatedRead':True,'appliedResultNull':True}
    privacy={'status':'passed','phase':'K2-life18','method':'actual-Worker-original-lookup-privacy','privateWireSaved':False,'refusalUi':False,'ledgerUnchangedClaim':False,'before':{'life':[18,20],'manualPhase':'open'},'countsBefore':counts,'hashesBefore':hashes,'publicStateSha256Before':'c'*64,'rows':[
        dict(common,variant='owner-original-before',**owner),dict(common,variant='wrong-actor-lookup',status='known-admission-error',errorKind='authenticated-local-unavailable',noResponsePayload=True),
        dict(common,variant='conflicting-body-lookup',status='indeterminate',sameAttemptId=True,oneFieldAmountChange=True,resultNull=True,appliedResultNull=True,rejection='invalid_interaction_response',currentMatchesAuthenticatedRead=True),dict(common,variant='owner-original-after',**owner)]}
    semantic={'life':[21,20],'mana':0,'stack':0,'carrierAbsent':True,'sourceInGraveyard':True,'nextInGraveyard':True};counts={'publications':9,'appliedResults':4,'completed':4}
    revoked={'status':'passed','phase':'supplemental-post-N-closed21','method':'existing-public-restore-actual-owner-revocation','issuedCapabilityHeld':True,'lawfulOriginalBefore':True,'pairedFreshMain1aRequired':True,'semanticBefore':semantic,'preStateSha256':'d'*64,'postRestoreBaseline':{'semantic':semantic,'stateSha256':'e'*64,'counts':counts,'replay':'known-recording-unavailable'},'rows':[
        {'variant':n,'status':'known-revocation-error','errorKind':'authenticated-local-unavailable','noResponsePayload':True,'postRestoreStateCountsSemanticsUnchanged':True,'replay':'known-recording-unavailable','newCapabilityNull':True,'semanticAfter':semantic,'stateSha256After':'e'*64,'countsAfter':counts}
        for n in ['held-cap-read','held-cap-restore','old-original-register','old-original-apply','old-original-lookup']]}
    for key in ['successfulRestoreHashEqualityClaim','recordedReplayPreservedClaim','sameBranchReauthentication','postRestoreUiClaim','privateWireSaved','wholeS5S8Accepted']:revoked[key]=False
    return copy.deepcopy({'lookup_privacy_checks':privacy,'owner_revocation_checks':revoked})

class LookupRevocationEvidence(unittest.TestCase):
    def test_separate_post_restore_baseline_and_known_unavailable(self):
        capture.validate_lookup_privacy_revocation(fixture())
    def test_arbitrary_errors_and_disclosed_results_are_not_privacy_pass(self):
        for index,key,value in [(1,'errorKind','transport-timeout'),(1,'noResponsePayload',False),(2,'resultNull',False),(3,'sameOriginalResult',False),(0,'hashesAfter',{'stateSha256':'f'*64})]:
            with self.subTest(key=key):
                a=fixture();a['lookup_privacy_checks']['rows'][index][key]=value
                with self.assertRaises(capture.EvidenceFailure):capture.validate_lookup_privacy_revocation(a)
    def test_revocation_requires_exact_reason_and_postrestore_invariants(self):
        for key,value in [('errorKind','transport-timeout'),('stateSha256After','d'*64),('replay','empty-log'),('newCapabilityNull',False),('noResponsePayload',False)]:
            with self.subTest(key=key):
                a=fixture();a['owner_revocation_checks']['rows'][0][key]=value
                with self.assertRaises(capture.EvidenceFailure):capture.validate_lookup_privacy_revocation(a)
    def test_no_samebranch_reauthentication_or_full_acceptance(self):
        for key in ['sameBranchReauthentication','recordedReplayPreservedClaim','wholeS5S8Accepted']:
            with self.subTest(key=key):
                a=fixture();a['owner_revocation_checks'][key]=True
                with self.assertRaises(capture.EvidenceFailure):capture.validate_lookup_privacy_revocation(a)
