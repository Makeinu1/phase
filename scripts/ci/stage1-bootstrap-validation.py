#!/usr/bin/env python3
"""Finite Stage1 bootstrap verification, shared by the three validation jobs.

The immutable validation checkout supplies this script; commands execute with
the immutable product checkout as cwd. Artifact states and cold build decisions
stay in the workflow. This script neither invokes Cargo builds nor bindgen.
"""
import datetime
import hashlib
import re
import sys

def digest(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()

def recipe(kind, feature):
    features = ['manual_resolution_local_bootstrap'] if feature == 'enabled' else []
    if kind in ['native', 'checks']:
        return {'features': features, 'profile': 'test', 'nextest_profile': 'ci', 'codegen_backend': 'cranelift',
            'opt_level': 0, 'debug': 0, 'split_debuginfo': 'unpacked', 'codegen_units': 256, 'jobs': 1, 'incremental': 0,
            'stack_size': 16777216, 'profile_environment': {'CARGO_PROFILE_DEV_DEBUG': '0'}}
    return {'features': features, 'profile': 'wasm-dev', 'inherits': 'dev', 'codegen_backend': 'llvm', 'opt_level': 2,
        'debug': 0, 'split_debuginfo': 'unpacked', 'jobs': 1, 'incremental': 0, 'stack_size': 16777216,
        'profile_environment': {'CARGO_PROFILE_DEV_DEBUG': '0'}, 'bindgen': 'wasm-bindgen 0.2.121', 'target': 'wasm32-unknown-unknown'}

def receipts(kind, feature):
    base = ['stage1-source-before', 'stage1-rust-tools']
    if kind == 'native': return base + (['candidate-native-off-archive', 'native-off-archive-source-after'] if feature == 'off' else ['candidate-native-enabled-archive', 'native-archive-source-after'])
    if kind == 'checks': return base + ['candidate-format', 'candidate-clippy', 'native-checks-source-after']
    if kind == 'raw': return base + ['candidate-wasm-' + feature + '-build', 'wasm-' + feature + '-raw-source-after']
    return base + ['candidate-wasm-' + feature + '-bindgen', 'wasm-' + feature + '-full-source-after']

def receipt_valid(item, label, producer, native, inputs):
    keys = {'label','started_at','source_sha','event_sha','source_tree','argv','input_sha256','environment','guard','preflight',
        'finished_at','exit_code','effective_exit','stop_reason','source_unchanged','.log_sha256','.jsonl_sha256'}
    assert set(item) == keys and item['label'] == label
    assert item['source_sha'] == 'a7402dda9062ede8eddd1b0c725048edaaad35a8' and item['source_tree'] == '96d4074830db3c05bc103e96cdc1104284d4a106'
    assert item['event_sha'] == producer['sha']
    assert type(item['exit_code']) is int and item['exit_code'] == item['effective_exit'] == 0 and item['stop_reason'] is None and item['source_unchanged'] is True
    assert item['input_sha256'] == {key: inputs[key] for key in ['Cargo.lock','client/pnpm-lock.yaml','rust-toolchain.toml']}
    assert item['guard'] == {'working_set_bytes':13*1024**3,'disk_free_min_bytes':4*1024**3,'sample_interval_seconds':1,
        'timeout_seconds':2400 if label in ['candidate-wasm-off-build','candidate-wasm-enabled-build'] else 1500}
    environment = item['environment']
    assert set(environment) == {'CARGO_TARGET_DIR','CARGO_BUILD_JOBS','RUST_MIN_STACK','CARGO_INCREMENTAL','CARGO_PROFILE_DEV_DEBUG'}
    assert environment['CARGO_BUILD_JOBS'] == '1' and environment['CARGO_INCREMENTAL'] == '0' and environment['RUST_MIN_STACK'] == '16777216'
    assert environment['CARGO_PROFILE_DEV_DEBUG'] == (None if label == 'stage1-source-before' else '0')
    suffix = '/bootstrap-native-target' if native else '/bootstrap-wasm-target'
    assert isinstance(environment['CARGO_TARGET_DIR'], str) and environment['CARGO_TARGET_DIR'].endswith(suffix)
    reading = item['preflight']
    assert reading['cap_bytes'] >= 13*1024**3 and reading['working_set_bytes'] <= 13*1024**3
    assert min(reading['workspace_free_bytes'],reading['temp_free_bytes']) >= 4*1024**3
    assert all(re.fullmatch('[a-f0-9]{64}', item[key]) for key in ['.log_sha256','.jsonl_sha256'])
    assert datetime.datetime.fromisoformat(item['finished_at']) >= datetime.datetime.fromisoformat(item['started_at'])
    if label == 'stage1-rust-tools': assert item['argv'] == ['python3', '../validation-source/scripts/ci/stage1-bootstrap-validation.py', 'native-tools' if native else 'wasm-tools']
    elif label == 'stage1-source-before' or label.endswith('-source-after'): assert item['argv'] == ['true']
    else:
        assert item['argv'][:4] == ['bash','-euo','pipefail','-c'] and len(item['argv']) == 5
        actual = item['argv'][4].strip()
        feature = 'enabled' if '-enabled-' in label else 'off'
        commands = {
            'candidate-native-off-archive': 'cargo nextest archive --locked --profile ci --config profile.test.debug=0 --config profile.test.incremental=false --config \'profile.test.codegen-backend="cranelift"\' -p engine-wasm --lib --no-default-features --archive-file "$RUNNER_TEMP/bootstrap-native-archives/off.tar.zst"',
            'candidate-native-enabled-archive': 'cargo nextest archive --locked --profile ci --config profile.test.debug=0 --config profile.test.incremental=false --config \'profile.test.codegen-backend="cranelift"\' -p engine-wasm --lib --no-default-features --features manual_resolution_local_bootstrap --archive-file "$RUNNER_TEMP/bootstrap-native-archives/enabled.tar.zst"',
            'candidate-format': 'rustfmt --edition 2021 --check crates/engine-wasm/src/lib.rs crates/engine/src/game/effects/life.rs',
            'candidate-clippy': 'cargo clippy --locked -p engine-wasm --all-targets --profile test --no-default-features --features manual_resolution_local_bootstrap --config profile.test.debug=0 --config profile.test.incremental=false --config "profile.test.codegen-backend=\\"cranelift\\"" --message-format=json -- -D warnings',
        }
        if label.endswith('-build'):
            expected = 'cargo build --locked -p engine-wasm --target wasm32-unknown-unknown --profile wasm-dev --no-default-features'
            if feature == 'enabled': expected += ' --features manual_resolution_local_bootstrap'
            expected += ' --message-format=json'
        elif label.endswith('-bindgen'):
            expected = 'wasm-bindgen --target web --out-name engine_wasm --out-dir "$RUNNER_TEMP/bootstrap-bindgen-' + feature + '" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/wasm-dev/engine_wasm.wasm"'
        else: expected = commands[label]
        assert actual == expected


def helper_exception(error):
    """Retain finite exception codes and this helper's coordinates, never messages."""
    import traceback
    from pathlib import Path
    names = {'AssertionError','AttributeError','KeyError','IndexError','ValueError','TypeError',
        'OverflowError','RuntimeError','OSError','PermissionError','FileNotFoundError',
        'IsADirectoryError','NotADirectoryError','UnicodeError','UnicodeDecodeError',
        'UnicodeEncodeError','JSONDecodeError','TOMLDecodeError','CalledProcessError',
        'TimeoutExpired','HTTPError','URLError'}
    code = type(error).__name__ if type(error).__name__ in names else None
    frames = [frame for frame in traceback.extract_tb(error.__traceback__, limit=8)
        if Path(frame.filename).resolve() == Path(__file__).resolve() and 1 <= frame.lineno <= 1000000]
    place = {'path':'scripts/ci/stage1-bootstrap-validation.py','line':frames[-1].lineno,'column':1} if frames else None
    diagnostics = [{'level':'error','code':code,'location':place}]
    for field, prefix, lower, upper in [('errno','errno:',1,4095),('returncode','child-exit:',-255,255)]:
        number = getattr(error, field, None)
        if type(number) is int and lower <= number <= upper:
            diagnostics.append({'level':'error','code':prefix + str(number),'location':place})
    return {'status':'helper-exception','diagnostics':diagnostics,'codes_withheld':int(code is None),'locations_withheld':0}


def source():
    import ast, hashlib, json, os, re, subprocess
    from pathlib import Path
    try:
        assert os.environ.get('STAGE1_DIAGNOSTIC_CHECKPOINT') in ['fixture-only','resume']
        def git(source, *args):
            return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
        source = Path('.'); validation = Path('../validation-source')
        workflow_path = '.github/workflows/wasm-local-bootstrap-validation.yml'
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        assert os.environ['GITHUB_REPOSITORY'] == event['repository']['full_name'] == 'Makeinu1/phase'
        assert os.environ['GITHUB_REPOSITORY_ID'] == str(event['repository']['id']) == '1377698441'
        assert os.environ['GITHUB_EVENT_NAME'] == 'push' and os.environ['GITHUB_RUN_ATTEMPT'] == '1'
        assert os.environ['GITHUB_REF'] == event['ref'] == 'refs/heads/experiment/manual-wasm-stage1-validation'
        assert event['deleted'] is False
        assert event['after'] == os.environ['GITHUB_WORKFLOW_SHA'] == os.environ['GITHUB_SHA'] == git(validation, 'rev-parse', 'HEAD')
        assert re.fullmatch('[a-f0-9]{40}', os.environ['GITHUB_SHA'])
        assert git(source, 'rev-parse', 'HEAD') == os.environ['MANUAL_EXPECTED_SOURCE_SHA'] == 'a7402dda9062ede8eddd1b0c725048edaaad35a8'
        assert git(source, 'rev-parse', 'HEAD^{tree}') == '96d4074830db3c05bc103e96cdc1104284d4a106'
        assert git(source, 'status', '--porcelain') == git(validation, 'status', '--porcelain') == ''
        changed = git(validation, 'diff', '--name-only', os.environ['MANUAL_EXPECTED_SOURCE_SHA'], 'HEAD').splitlines()
        assert set(changed) <= {workflow_path, 'scripts/ci/manual-integration-guard.py', 'scripts/ci/stage1-bootstrap-browser.sh', 'scripts/ci/stage1-bootstrap-validation.py'}
        pins = {
            'Cargo.lock': '5285fad7759794f57019d5d73e49cbc35207395b7faf31341da5bc80d32463f0',
            'client/pnpm-lock.yaml': 'bc13ba1f6de5efd5bc724d9945aa541136df1d6938a41c53768f76c7b36c4ea4',
            'rust-toolchain.toml': '52562c175563386d0f9f19afafd2855662ef2590765204b35bd624de13fe67af',
            'Cargo.toml': '1821bf54554639dfa513d03a2a71e1503b445df42e62cde93e31b7e5289ea64a',
            '.cargo/config.toml': 'da039ac38eb9d43e236e9eb89c65ef30a149d0539ed7ebfb3ee8f1d78b383c66',
            '.config/nextest.toml': 'ad466230f2659e95584196fbd2e554cfa3c2345313a103a82847d91e9f9a34db',
            'crates/engine-wasm/Cargo.toml': 'e70ecac5eb259cd3dd9fa6e0d38e6a346ced035fec727af3fdfed8a650f1f469',
        }
        assert all(hashlib.sha256((source / name).read_bytes()).hexdigest() == digest for name, digest in pins.items())
        guard_hash = hashlib.sha256((validation / 'scripts/ci/manual-integration-guard.py').read_bytes()).hexdigest()
        assert guard_hash == os.environ['STAGE1_GUARD_SHA256']
        current = (validation / workflow_path).read_text()
        def extract(workflow, marker, count):
            opening = "<<'" + marker + "'\n"; closing = '        ' + marker + '\n'
            assert workflow.count(opening) == workflow.count(closing) == 1
            lines = workflow.split(opening, 1)[1].split(closing, 1)[0].splitlines(keepends=True)
            assert len(lines) == count and all(line.startswith('        ') for line in lines)
            return ''.join(line[8:] for line in lines)
        scripts = {
            'collector': (extract((source / workflow_path).read_text(), 'NATIVE', 35), 'cbbd22b60f2f4b6630748bb277fe75c89d4df68ef1edc96e76fe008db0a223e4'),
            'tools': (extract(current, 'OFF_TOOLS', 136), '395795de836078fee7b495933739223264c28384f95b8d3bb94315b34795c1f5'),
        }
        for name, (script, digest) in scripts.items():
            assert hashlib.sha256(script.encode()).hexdigest() == digest
            ast.parse(script)
            (Path(os.environ['RUNNER_TEMP']) / ('bootstrap-native-off-' + name + '.py')).write_text(script)
        assert {key: value for key, value in os.environ.items() if key.startswith('CARGO_PROFILE_')} == {}
        assert 'RUSTFLAGS' not in os.environ and 'CARGO_ENCODED_RUSTFLAGS' not in os.environ
        assert os.environ['CARGO_BUILD_JOBS'] == '1' and os.environ['CARGO_INCREMENTAL'] == '0' and os.environ['RUST_MIN_STACK'] == '16777216'
        root = Path(os.environ['MANUAL_EVIDENCE']); root.mkdir(parents=True, exist_ok=True)
        value = {'source_sha': os.environ['MANUAL_EXPECTED_SOURCE_SHA'], 'source_tree': git(source, 'rev-parse', 'HEAD^{tree}'),
            'validation_sha': os.environ['GITHUB_SHA'], 'validation_tree': git(validation, 'rev-parse', 'HEAD^{tree}'),
            'workflow_sha256': hashlib.sha256(current.encode()).hexdigest(), 'guard_sha256': guard_hash,
            'product_equal': True, 'input_sha256': pins, 'run_id': int(os.environ['GITHUB_RUN_ID']), 'run_attempt': 1}
        (root / 'source-manifest.json').write_text(json.dumps(value) + '\n')
        print('{"stage1_sources_admitted":true,"product_equal":true}')
    except Exception as error:
        print(__import__('json').dumps({'error':'stage1-source-refused','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)


def select():
    import json, os, re
    from pathlib import Path
    try:
        def selected(value, native=False, off=False):
            if value == '': return 'EMPTY'
            record = json.loads(value)
            assert isinstance(record, dict) and set(record) == ({'archive', 'checks'} if native else {'raw', 'full'})
            first, last = ('archive', 'checks') if native else ('raw', 'full')
            assert isinstance(record[first], dict) and record[first]
            assert record[last] is None or isinstance(record[last], dict) and record[last]
            assert not off or record[last] is None
            return ('FULL' if record[last] is not None else 'RAW')
        refs = {'native_off': os.environ['STAGE1_NATIVE_OFF_REF'], 'native': os.environ['STAGE1_NATIVE_ENABLED_REF'], 'off': os.environ['STAGE1_WASM_OFF_REF'], 'enabled': os.environ['STAGE1_WASM_ENABLED_REF']}
        states = {key: selected(value, key in ['native_off','native'], key == 'native_off') for key, value in refs.items()}
        (Path(os.environ['MANUAL_EVIDENCE']) / 'selection.json').write_text(json.dumps({'states': states, 'product_green': False}) + '\n')
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            for key, state in states.items(): output.write(key + '=' + state + '\n')
        print(json.dumps({'retained_states': states, 'product_green': False}))
    except Exception as error:
        print(__import__('json').dumps({'error':'stage1-retained-ref-invalid','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)


def native_tools():
    exec(compile(__import__('pathlib').Path(__import__('os').environ['RUNNER_TEMP'], 'bootstrap-native-off-tools.py').read_text(), '<existing-native-tools>', 'exec'), {})


def wasm_tools():
    import datetime, hashlib, os, re, subprocess, tomllib
    from pathlib import Path
    try:
        def profile_environment_matches(environment, expected):
            return {name: value for name, value in environment.items()
                    if name.startswith('CARGO_PROFILE_')} == expected
        def fixed_flags_environment_matches(environment):
            return 'RUSTFLAGS' not in environment and 'CARGO_ENCODED_RUSTFLAGS' not in environment
        def receipt_profile_matches(label, environment, expected):
            return (label in expected and 'CARGO_PROFILE_DEV_DEBUG' in environment and
                    environment['CARGO_PROFILE_DEV_DEBUG'] == expected[label])
        expected_profile = {'CARGO_PROFILE_DEV_DEBUG': '0'}
        producer_receipt_profiles = {
            'candidate-source-before': None, 'baseline-source-before': None, 'baseline-runtime-inputs': None,
            'producer-tools': '0', 'baseline-wasm-build': '0', 'baseline-bindgen': '0',
            'candidate-source-after': '0', 'baseline-source-after': '0',
        }
        # Twenty fixed public assertions: eleven profile, six receipt, three flag; five positive/fifteen negative.
        assert profile_environment_matches({'CARGO_PROFILE_DEV_DEBUG': '0', 'NON_PROFILE': ''}, expected_profile)
        assert not profile_environment_matches({}, expected_profile)
        assert not profile_environment_matches({'CARGO_PROFILE_DEV_DEBUG': ''}, expected_profile)
        assert not profile_environment_matches({'CARGO_PROFILE_DEV_DEBUG': '1'}, expected_profile)
        assert not profile_environment_matches({'CARGO_PROFILE_DEV_DEBUG': 0}, expected_profile)
        assert not profile_environment_matches({'CARGO_PROFILE_DEV_DEBUG': '0', 'CARGO_PROFILE_WASM_DEV_OPT_LEVEL': ''}, expected_profile)
        assert not profile_environment_matches({'CARGO_PROFILE_DEV_DEBUG': '0', 'CARGO_PROFILE_WASM_DEV_OPT_LEVEL': '2'}, expected_profile)
        assert profile_environment_matches({}, {})
        assert not profile_environment_matches({'CARGO_PROFILE_DEV_DEBUG': '0'}, {})
        assert not profile_environment_matches({'CARGO_PROFILE_DEV_DEBUG': ''}, {})
        assert not profile_environment_matches({'CARGO_PROFILE_WASM_DEV_OPT_LEVEL': ''}, {})
        assert receipt_profile_matches('candidate-source-before', {'CARGO_PROFILE_DEV_DEBUG': None}, producer_receipt_profiles)
        assert receipt_profile_matches('producer-tools', {'CARGO_PROFILE_DEV_DEBUG': '0'}, producer_receipt_profiles)
        assert not receipt_profile_matches('producer-tools', {'CARGO_PROFILE_DEV_DEBUG': None}, producer_receipt_profiles)
        assert not receipt_profile_matches('producer-tools', {'CARGO_PROFILE_DEV_DEBUG': ''}, producer_receipt_profiles)
        assert not receipt_profile_matches('candidate-source-before', {'CARGO_PROFILE_DEV_DEBUG': '0'}, producer_receipt_profiles)
        assert not receipt_profile_matches('unknown', {'CARGO_PROFILE_DEV_DEBUG': None}, producer_receipt_profiles)
        assert fixed_flags_environment_matches({})
        assert not fixed_flags_environment_matches({'RUSTFLAGS': ''})
        assert not fixed_flags_environment_matches({'CARGO_ENCODED_RUSTFLAGS': ''})
        assert profile_environment_matches(os.environ, expected_profile)
        assert fixed_flags_environment_matches(os.environ)
        assert os.environ['CARGO_BUILD_JOBS'] == '1' and os.environ['CARGO_INCREMENTAL'] == '0'
        for source in [Path('.')]:
            manifest_bytes = (source / 'Cargo.toml').read_bytes()
            assert hashlib.sha256(manifest_bytes).hexdigest() == '1821bf54554639dfa513d03a2a71e1503b445df42e62cde93e31b7e5289ea64a'
            profiles = tomllib.loads(manifest_bytes.decode('utf-8'))['profile']
            assert profiles['dev'] == {'opt-level': 0, 'debug': 'line-tables-only', 'split-debuginfo': 'unpacked',
                                       'package': {'libmimalloc-sys': {'opt-level': 2}}}
            assert profiles['wasm-dev'] == {'inherits': 'dev', 'opt-level': 2, 'codegen-backend': 'llvm'}
            config_bytes = (source / '.cargo/config.toml').read_bytes()
            assert hashlib.sha256(config_bytes).hexdigest() == 'da039ac38eb9d43e236e9eb89c65ef30a149d0539ed7ebfb3ee8f1d78b383c66'
            config = tomllib.loads(config_bytes.decode('utf-8'))
            assert config['target'] == {'wasm32-unknown-unknown': {
                'rustflags': ['-C', 'link-arg=-z', '-C', 'link-arg=stack-size=16777216']}}
            assert config['env'] == {'RUST_MIN_STACK': '16777216'}
        assert os.environ['CARGO_TARGET_DIR'] == str(Path(os.environ['RUNNER_TEMP']) / 'bootstrap-wasm-target')
        baseline = Path('.').resolve()
        fixed_config = (baseline / '.cargo/config.toml').resolve()
        assert not (baseline / '.cargo/config').exists() and not (baseline / '.cargo/config').is_symlink()
        cargo_home = Path(os.environ.get('CARGO_HOME', str(Path.home() / '.cargo')))
        if not cargo_home.is_absolute():
            cargo_home = baseline / cargo_home
        loaded_configs = set()
        for directory in [baseline / '.cargo', *(parent / '.cargo' for parent in baseline.parents), cargo_home]:
            legacy, modern = directory / 'config', directory / 'config.toml'
            selected = legacy if legacy.exists() or legacy.is_symlink() else modern
            if selected.exists() or selected.is_symlink():
                assert selected.is_file()
                loaded_configs.add(selected.resolve())
        assert fixed_config in loaded_configs
        for selected in loaded_configs - {fixed_config}:
            config = tomllib.loads(selected.read_text(encoding='utf-8'))
            assert not {'profile', 'include', 'target', 'paths', 'source', 'unstable'} & set(config)
            build = config.get('build', {})
            environment = config.get('env', {})
            assert isinstance(build, dict) and isinstance(environment, dict)
            assert not {'rustc', 'rustdoc', 'rustc-wrapper', 'rustc-workspace-wrapper', 'rustflags', 'rustdocflags',
                        'target', 'jobs', 'incremental', 'target-dir'} & set(build)
            assert not any(name.startswith('CARGO_PROFILE_') or name.startswith('CARGO_TARGET_') or name in {
                'RUSTC', 'RUSTDOC', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER',
                'RUST_MIN_STACK', 'CARGO_BUILD_RUSTC', 'CARGO_BUILD_RUSTDOC', 'CARGO_BUILD_RUSTC_WRAPPER',
                'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTFLAGS', 'CARGO_BUILD_RUSTDOCFLAGS',
                'CARGO_BUILD_TARGET', 'CARGO_BUILD_JOBS', 'CARGO_BUILD_INCREMENTAL', 'CARGO_BUILD_TARGET_DIR',
                'CARGO_INCREMENTAL', 'CARGO_TARGET_DIR', 'RUSTDOCFLAGS', 'CARGO_ENCODED_RUSTDOCFLAGS',
            } for name in environment)
        def read(argv):
            return subprocess.check_output(argv, text=True).strip()
        active = read(['rustup', 'show', 'active-toolchain']).split()[0]
        assert active == 'nightly-2026-04-19-x86_64-unknown-linux-gnu'
        verbose = read(['rustc', '-Vv'])
        assert verbose == read(['rustup', 'run', 'nightly-2026-04-19', 'rustc', '-Vv'])
        fields = dict(line.split(': ', 1) for line in verbose.splitlines()[1:])
        assert set(fields) == {'binary', 'commit-hash', 'commit-date', 'host', 'release', 'LLVM version'}
        assert fields['binary'] == 'rustc' and fields['host'] == 'x86_64-unknown-linux-gnu'
        assert re.fullmatch('[0-9]+[.][0-9]+[.][0-9]+-nightly', fields['release'])
        assert re.fullmatch('[a-f0-9]{40}', fields['commit-hash'])
        assert datetime.date.fromisoformat(fields['commit-date']) <= datetime.date(2026, 4, 19)
        assert re.fullmatch('[0-9]+[.][0-9]+[.][0-9]+', fields['LLVM version'])
        cargo = read(['cargo', '-V'])
        assert cargo == read(['rustup', 'run', 'nightly-2026-04-19', 'cargo', '-V'])
        assert re.fullmatch(r'cargo [0-9]+[.][0-9]+[.][0-9]+-nightly \([a-f0-9]+ [0-9]{4}-[0-9]{2}-[0-9]{2}\)', cargo)
        assert read(['wasm-bindgen', '--version']) == 'wasm-bindgen 0.2.121'
        assert 'wasm32-unknown-unknown' in read(['rustup', 'target', 'list', '--installed']).splitlines()
        import json
        value = {'toolchain':'nightly-2026-04-19','rustc':fields,'cargo':cargo,'bindgen':'wasm-bindgen 0.2.121','wasm_target_installed':True}
        (Path(os.environ['MANUAL_EVIDENCE']) / 'tool-manifest.json').write_text(json.dumps(value) + '\n')
        print('{"producer_tools_verified":true}')
    except Exception as error:
        print(__import__('json').dumps({'error':'runtime-provenance-mismatch','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)


def package():
    import datetime, hashlib, json, os, re, shutil, stat
    from pathlib import Path
    try:
        root = Path(os.environ['MANUAL_EVIDENCE']); temp = Path(os.environ['RUNNER_TEMP'])
        source = json.loads((root / 'source-manifest.json').read_text()); inputs = source['input_sha256']
        feature, kind = os.environ['STAGE1_FEATURE'], os.environ['STAGE1_KIND']
        assert feature in ['off','enabled'] and kind in ['native','checks','raw','full']
        assert kind != 'checks' or feature == 'enabled'
        producer = {'repository':'Makeinu1/phase','repository_id':1377698441,'sha':source['validation_sha'],'tree':source['validation_tree'],
            'workflow_path':'.github/workflows/wasm-local-bootstrap-validation.yml','workflow_sha256':source['workflow_sha256'],
            'guard_sha256':source['guard_sha256'],'run_id':int(os.environ['GITHUB_RUN_ID']),'run_attempt':1,
            'ref':'refs/heads/experiment/manual-wasm-stage1-validation','job_name':os.environ['STAGE1_JOB_NAME']}
        assert source['product_equal'] is True
        assert {key:value for key,value in os.environ.items() if key.startswith('CARGO_PROFILE_')} == {'CARGO_PROFILE_DEV_DEBUG':'0'}
        records = {label:json.loads((root / (label + '.json')).read_text()) for label in receipts(kind,feature)}
        for label,item in records.items(): receipt_valid(item,label,producer,kind in ['native','checks'], inputs)
        tools = json.loads((root / 'tool-manifest.json').read_text())
        assert tools.get('error') is None
        if kind in ['native','checks']: tools = {name:tools[name] for name in ['toolchain','rustc','cargo','nextest','nextest_query']}
        if kind == 'checks':
            archive = json.loads((root / 'enabled-native-descriptor.json').read_text())
            assert archive['kind'] == 'native' and archive['product'] == {'sha':source['source_sha'],'tree':source['source_tree']}
            assert archive['recipe'] == recipe('native','enabled') and archive['tools'] == tools
        names = {'engine_wasm.js','engine_wasm_bg.wasm','engine_wasm.d.ts','engine_wasm_bg.wasm.d.ts'}
        raw = None
        if kind == 'native': paths = {feature + '.tar.zst':temp / ('bootstrap-native-archives/' + feature + '.tar.zst')}
        elif kind == 'checks': paths = {}
        elif kind == 'raw': paths = {'engine_wasm.wasm':temp / 'bootstrap-wasm-target/wasm32-unknown-unknown/wasm-dev/engine_wasm.wasm'}
        else:
            output = temp / ('bootstrap-bindgen-' + feature)
            paths = {name:output / name for name in names}
            snippet_files = []
            if (output / 'snippets').exists():
                assert (output / 'snippets').is_dir() and not (output / 'snippets').is_symlink()
                for item in (output / 'snippets').rglob('*'):
                    info = item.lstat(); assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
                    if item.is_file(): snippet_files.append(item.relative_to(output).as_posix())
            imports = re.findall(r"import\s*\{\s*is_experimental_local_worker_realm\s*\}\s*from\s*['\"]([^'\"]+)['\"]", (output / 'engine_wasm.js').read_text())
            if feature == 'enabled':
                assert len(imports) == 1 and imports[0].startswith('./snippets/')
                relative = imports[0][2:]
                assert relative.endswith('/src/experimental-local-worker-realm.js')
                assert all(re.fullmatch('[A-Za-z0-9_-]+(?:[.][A-Za-z0-9_-]+)*', part) and part not in ['.','..'] for part in relative.split('/'))
                assert snippet_files == [relative]
                assert (output / relative).read_bytes() == Path('crates/engine-wasm/src/experimental-local-worker-realm.js').read_bytes()
                paths[relative] = output / relative
            else: assert imports == [] and snippet_files == [] and not (output / 'snippets').exists()
            assert {item.name for item in output.iterdir()} == names | ({'snippets'} if feature == 'enabled' else set())
            raw = json.loads((root / (feature + '-raw-descriptor.json')).read_text())
            assert raw['kind'] == 'raw' and raw['feature'] == feature and raw['product'] == {'sha':source['source_sha'],'tree':source['source_tree']}
            assert raw['tools'] == tools and raw['recipe'] == recipe('raw',feature)
        files = {}
        for name,item in paths.items():
            info = item.lstat()
            assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size > 0
            files[name] = {'size':info.st_size,'sha256':digest(item)}
        descriptor = {'schema_version':1,'product':{'sha':source['source_sha'],'tree':source['source_tree']},'producer':producer,
            'feature':feature,'kind':kind,'inputs':inputs,'tools':tools,'recipe':recipe(kind,feature),'files':files,'receipts':records,'raw':raw}
        staging = temp / ('bootstrap-public-' + feature + '-' + kind); staging.mkdir()
        for name,item in paths.items():
            destination = staging / name; destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(item,destination); assert digest(destination) == files[name]['sha256']
        (staging / 'runtime-provenance.json').write_text(json.dumps(descriptor,sort_keys=True,indent=2) + '\n')
        (root / (feature + '-' + kind + '-descriptor.json')).write_text(json.dumps(descriptor) + '\n')
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            output.write('paths<<PUBLIC_PATHS\n' + '\n'.join(str(staging / name) for name in [*sorted(paths),'runtime-provenance.json']) + '\nPUBLIC_PATHS\n')
        print(json.dumps({'public_package_verified':True,'feature':feature,'kind':kind}))
    except Exception as error:
        print(__import__('json').dumps({'error':'stage1-public-package-refused','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)


def pins():
    import datetime, hashlib, json, os, re, time, urllib.request
    from pathlib import Path
    try:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, status, message, headers, newurl): return None
        def api(path):
            request = urllib.request.Request('https://api.github.com/repos/Makeinu1/phase/' + path,
                headers={'Authorization':'Bearer ' + os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'})
            with urllib.request.build_opener(NoRedirect()).open(request,timeout=60) as response:
                content = response.read(2*1024**2 + 1); assert len(content) <= 2*1024**2
                return json.loads(content)
        root = Path(os.environ['MANUAL_EVIDENCE']); feature,kind = os.environ['STAGE1_FEATURE'],os.environ['STAGE1_KIND']
        descriptor = json.loads((root / (feature + '-' + kind + '-descriptor.json')).read_text()); producer = descriptor['producer']
        assert re.fullmatch('[1-9][0-9]*',os.environ['STAGE1_UPLOAD_ID']) and re.fullmatch('[a-f0-9]{64}',os.environ['STAGE1_UPLOAD_DIGEST'])
        metadata = api('actions/artifacts/' + os.environ['STAGE1_UPLOAD_ID'])
        assert metadata['id'] == int(os.environ['STAGE1_UPLOAD_ID']) and metadata['name'] == 'local-worker-bootstrap-stage1-' + feature + '-' + kind
        assert type(metadata['size_in_bytes']) is int and metadata['size_in_bytes'] > 0
        assert metadata['digest'] == 'sha256:' + os.environ['STAGE1_UPLOAD_DIGEST'] and metadata['expired'] is False
        assert datetime.datetime.fromisoformat(metadata['expires_at'].replace('Z','+00:00')) > datetime.datetime.now(datetime.timezone.utc)
        run = metadata['workflow_run']
        assert run['id'] == producer['run_id'] and run['head_sha'] == producer['sha'] and run['repository_id'] == run['head_repository_id'] == 1377698441
        boundary = 'Retain ' + feature + ' ' + kind + ' public output'
        job_id = None
        # The just-finished upload may still be pending in the jobs API. Retry
        # only that observation, at most five reads and four two-second waits.
        for attempt in range(1, 6):
            jobs = api('actions/runs/' + str(producer['run_id']) + '/attempts/1/jobs?per_page=100')
            assert type(jobs['total_count']) is int and jobs['total_count'] == len(jobs['jobs']) <= 100
            selected = [job for job in jobs['jobs'] if job['name'] == producer['job_name']]
            assert len(selected) == 1 and selected[0]['run_attempt'] == 1
            job = selected[0]; assert type(job['id']) is int and job['id'] > 0
            assert job_id is None or job['id'] == job_id
            job_id = job['id']; steps = job['steps']
            assert isinstance(steps, list) and all(isinstance(step, dict) for step in steps)
            uploads = [step for step in steps if step['name'] == boundary]
            upload = uploads[0] if len(uploads) == 1 else {}
            status, conclusion = upload.get('status'), upload.get('conclusion')
            statuses = [None, 'queued', 'in_progress', 'completed']
            conclusions = [None, 'success', 'failure', 'cancelled', 'timed_out', 'skipped', 'action_required', 'neutral', 'stale']
            print(json.dumps({'upload_metadata_observation':{'attempt':attempt,'job_id':job_id,'matches':len(uploads),
                'number':upload.get('number') if type(upload.get('number')) is int and 1 <= upload['number'] <= 10000 else None,
                'job_status':job.get('status') if job.get('status') in statuses[1:] else 'unknown',
                'status':status if status in statuses else 'unknown','conclusion':conclusion if conclusion in conclusions else 'unknown'}}))
            numbers = [step['number'] for step in steps]; names = [step['name'] for step in steps]
            assert all(type(number) is int and number > 0 for number in numbers) and numbers == sorted(set(numbers))
            assert all(isinstance(name, str) for name in names) and len(names) == len(set(names))
            assert len(uploads) <= 1 and job['status'] in statuses[1:] and status in statuses and conclusion in conclusions
            if status == 'completed':
                assert conclusion == 'success'
                break
            assert conclusion is None and job['status'] != 'completed' and attempt < 5
            time.sleep(2)
        assert datetime.datetime.fromisoformat(metadata['expires_at'].replace('Z','+00:00')) > datetime.datetime.now(datetime.timezone.utc)
        created = datetime.datetime.fromisoformat(metadata['created_at'].replace('Z','+00:00'))
        assert datetime.datetime.fromisoformat(uploads[0]['started_at'].replace('Z','+00:00')) <= created <= datetime.datetime.fromisoformat(uploads[0]['completed_at'].replace('Z','+00:00'))
        record = {'kind':kind,'feature':feature,'producer':{**producer,'job_id':job['id']},
            'artifact':{'id':metadata['id'],'name':metadata['name'],'size':metadata['size_in_bytes'],'sha256':os.environ['STAGE1_UPLOAD_DIGEST']},
            'manifest_sha256':hashlib.sha256((Path(os.environ['RUNNER_TEMP']) / ('bootstrap-public-' + feature + '-' + kind) / 'runtime-provenance.json').read_bytes()).hexdigest(),
            'files':descriptor['files']}
        reference_path = root / (('native-off' if kind == 'native' and feature == 'off' else 'native' if kind in ['native','checks'] else feature) + '-reference.json')
        reference = json.loads(reference_path.read_text()) if reference_path.exists() else ({'archive':None,'checks':None} if kind in ['native','checks'] else {'raw':None,'full':None})
        reference['archive' if kind == 'native' else kind] = record
        reference_path.write_text(json.dumps(reference,separators=(',',':')) + '\n')
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output: output.write('reference=' + json.dumps(reference,separators=(',',':')) + '\n')
        print(json.dumps({'public_output_uploaded':True,'feature':feature,'kind':kind,'artifact_id':metadata['id']}))
    except Exception as error:
        print(__import__('json').dumps({'error':'stage1-upload-metadata-refused','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)


def admit():
    import base64, datetime, hashlib, io, json, os, re, shutil, stat, urllib.error, urllib.parse, urllib.request, zipfile
    from pathlib import Path
    try:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, status, message, headers, newurl): return None
        def api(path):
            request = urllib.request.Request('https://api.github.com/repos/Makeinu1/phase/' + path,
                headers={'Authorization':'Bearer ' + os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'})
            with urllib.request.build_opener(NoRedirect()).open(request,timeout=60) as response:
                content = response.read(2*1024**2 + 1); assert len(content) <= 2*1024**2
                return json.loads(content)
        def https(url):
            parsed = urllib.parse.urlsplit(url)
            assert parsed.scheme == 'https' and parsed.hostname and parsed.username is None and parsed.password is None and not parsed.fragment
            return url
        class PublicRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, status, message, headers, newurl):
                return super().redirect_request(req,fp,status,message,headers,https(newurl))
        root = Path(os.environ['MANUAL_EVIDENCE']); temp = Path(os.environ['RUNNER_TEMP'])
        source = json.loads((root / 'source-manifest.json').read_text()); inputs = source['input_sha256']
        feature = os.environ['STAGE1_FEATURE']; native = feature in ['native-off','native']
        assert feature in ['native-off','native','off','enabled']
        reference = json.loads(os.environ['STAGE1_REFERENCE'])
        assert set(reference) == ({'archive','checks'} if native else {'raw','full'})
        assert reference['archive' if native else 'raw'] is not None
        assert feature != 'native-off' or reference['checks'] is None
        if os.environ['STAGE1_REQUIRE_FULL'] == 'true': assert reference['checks' if native else 'full'] is not None
        descriptors = {}
        for key in ('archive','checks') if native else ('raw','full'):
            record = reference[key]
            if record is None: continue
            kind = 'native' if key == 'archive' else key; selected_feature = 'off' if feature == 'native-off' else 'enabled' if native else feature
            assert set(record) == {'kind','feature','producer','artifact','manifest_sha256','files'}
            assert record['kind'] == kind and record['feature'] == selected_feature
            producer,artifact = record['producer'],record['artifact']
            assert set(producer) == {'repository','repository_id','sha','tree','workflow_path','workflow_sha256','guard_sha256','run_id','run_attempt','ref','job_name','job_id'}
            assert producer['repository'] == 'Makeinu1/phase' and producer['repository_id'] == 1377698441
            assert producer['workflow_path'] == '.github/workflows/wasm-local-bootstrap-validation.yml' and producer['ref'] == 'refs/heads/experiment/manual-wasm-stage1-validation'
            assert producer['job_name'] == ('stage1-native-producer' if native else 'stage1-wasm-producer') and producer['run_attempt'] == 1
            assert all(type(producer[name]) is int and producer[name] > 0 for name in ['run_id','run_attempt','job_id'])
            assert all(re.fullmatch('[a-f0-9]{40}',producer[name]) for name in ['sha','tree'])
            assert all(re.fullmatch('[a-f0-9]{64}',producer[name]) for name in ['workflow_sha256','guard_sha256'])
            assert set(artifact) == {'id','name','size','sha256'}
            assert type(artifact['id']) is int and artifact['id'] > 0 and type(artifact['size']) is int and 0 < artifact['size'] <= 512*1024**2
            assert artifact['name'] == 'local-worker-bootstrap-stage1-' + selected_feature + '-' + kind
            assert re.fullmatch('[a-f0-9]{64}',artifact['sha256']) and re.fullmatch('[a-f0-9]{64}',record['manifest_sha256'])
            run = api('actions/runs/' + str(producer['run_id']) + '/attempts/1')
            assert run['id'] == producer['run_id'] and run['run_attempt'] == 1
            assert run['repository']['id'] == run['head_repository']['id'] == 1377698441
            assert run['repository']['full_name'] == run['head_repository']['full_name'] == 'Makeinu1/phase'
            assert run['head_sha'] == producer['sha'] and run['head_commit']['tree_id'] == producer['tree']
            assert run['path'] == producer['workflow_path'] and run['event'] == 'push' and run['head_branch'] == 'experiment/manual-wasm-stage1-validation'
            # Own completed boundaries admit partial retention; the overall workflow may still be running.
            jobs = api('actions/runs/' + str(producer['run_id']) + '/attempts/1/jobs?per_page=100')
            assert jobs['total_count'] == len(jobs['jobs']) <= 100
            selected = [item for item in jobs['jobs'] if item['id'] == producer['job_id'] and item['name'] == producer['job_name']]
            assert len(selected) == 1 and selected[0]['run_attempt'] == 1
            job = selected[0]; steps = job['steps']
            numbers = [item['number'] for item in steps]; names = [item['name'] for item in steps]
            assert all(type(number) is int and number > 0 for number in numbers) and numbers == sorted(set(numbers)) and len(names) == len(set(names))
            boundaries = ['Admit clean immutable Stage1 sources','Capture Stage1 resource preflight','Verify actual Stage1 Rust tools']
            if kind == 'native': boundaries += ['Build the single missing native off archive','Check off native archive source after','Package off native public output'] if selected_feature == 'off' else ['Build the single missing native enabled archive','Check native archive source after','Package enabled native public output']
            elif kind == 'checks': boundaries += ['Check exact Rust formatting','Check exact candidate clippy','Check native checks source after','Package enabled checks public output']
            elif kind == 'raw': boundaries += ['Build the single missing ' + selected_feature + ' WASM','Check ' + selected_feature + ' raw source after','Package ' + selected_feature + ' raw public output']
            else: boundaries += ['Bind the remaining ' + selected_feature + ' WASM','Check ' + selected_feature + ' full source after','Package ' + selected_feature + ' full public output']
            # Admission independently rechecks actual upload metadata and every
            # artifact byte below; an earlier pin step is not artifact authority.
            boundaries += ['Retain ' + selected_feature + ' ' + kind + ' public output']
            for name in boundaries:
                matches = [item for item in steps if item['name'] == name]
                assert len(matches) == 1 and matches[0]['status'] == 'completed' and matches[0]['conclusion'] == 'success'
            if os.environ['STAGE1_REQUIRE_FULL'] == 'true':
                assert job['status'] == 'completed'
                if producer['run_id'] == int(os.environ['GITHUB_RUN_ID']): assert job['conclusion'] == 'success'
            if kind == 'raw' and reference['full'] is None and os.environ['STAGE1_REQUIRE_FULL'] == 'false':
                binding = [item for item in steps if item['name'] == 'Bind the remaining ' + selected_feature + ' WASM']
                assert len(binding) == 1 and binding[0]['conclusion'] in [None,'skipped']
                # A completed successful or failed bindgen has spent the one authorized attempt.
                # RAW retention does not grant another attempt; root owns a new spend decision.
            for name,size_key in [(producer['workflow_path'],'workflow_sha256'),('scripts/ci/manual-integration-guard.py','guard_sha256')]:
                content = api('contents/' + name + '?ref=' + producer['sha'])
                assert content['encoding'] == 'base64'
                public_bytes = base64.b64decode(content['content'],validate=False)
                assert len(public_bytes) == content['size'] and hashlib.sha256(public_bytes).hexdigest() == producer[size_key]
            metadata = api('actions/artifacts/' + str(artifact['id']))
            assert metadata['id'] == artifact['id'] and metadata['name'] == artifact['name'] and type(metadata['size_in_bytes']) is int and metadata['size_in_bytes'] == artifact['size']
            assert metadata['digest'] == 'sha256:' + artifact['sha256'] and metadata['expired'] is False
            assert datetime.datetime.fromisoformat(metadata['expires_at'].replace('Z','+00:00')) > datetime.datetime.now(datetime.timezone.utc)
            workflow_run = metadata['workflow_run']
            assert workflow_run['id'] == producer['run_id'] and workflow_run['head_sha'] == producer['sha']
            assert workflow_run['repository_id'] == workflow_run['head_repository_id'] == 1377698441 and workflow_run['head_branch'] == run['head_branch']
            upload = next(item for item in steps if item['name'] == 'Retain ' + selected_feature + ' ' + kind + ' public output')
            created = datetime.datetime.fromisoformat(metadata['created_at'].replace('Z','+00:00'))
            assert datetime.datetime.fromisoformat(upload['started_at'].replace('Z','+00:00')) <= created <= datetime.datetime.fromisoformat(upload['completed_at'].replace('Z','+00:00'))
            request = urllib.request.Request('https://api.github.com/repos/Makeinu1/phase/actions/artifacts/' + str(artifact['id']) + '/zip',
                headers={'Authorization':'Bearer ' + os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'})
            try: urllib.request.build_opener(NoRedirect()).open(request,timeout=60); raise AssertionError()
            except urllib.error.HTTPError as redirect:
                assert redirect.code == 302; location = https(redirect.headers['Location'])
            with urllib.request.build_opener(PublicRedirect()).open(urllib.request.Request(location),timeout=60) as response:
                https(response.geturl()); data = response.read(artifact['size'] + 1)
            assert len(data) == artifact['size'] and hashlib.sha256(data).hexdigest() == artifact['sha256']
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                members = archive.infolist(); names = [item.filename for item in members]
                assert len(names) == len(set(names)) and set(names) == set(record['files']) | {'runtime-provenance.json'}
                for item in members:
                    mode = item.external_attr >> 16
                    assert not item.is_dir() and not item.flag_bits & 1 and item.compress_type in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED]
                    assert stat.S_IFMT(mode) in [0,stat.S_IFREG] and not item.filename.startswith('/') and '\\' not in item.filename
                    assert all(re.fullmatch('[A-Za-z0-9_-]+(?:[.][A-Za-z0-9_-]+)*', part) and part not in ['.','..'] for part in item.filename.split('/'))
                manifest = archive.read('runtime-provenance.json'); assert 0 < len(manifest) <= 1024**2
                assert hashlib.sha256(manifest).hexdigest() == record['manifest_sha256']
                descriptor = json.loads(manifest)
                assert set(descriptor) == {'schema_version','product','producer','feature','kind','inputs','tools','recipe','files','receipts','raw'} and descriptor['schema_version'] == 1
                assert descriptor['product'] == {'sha':'a7402dda9062ede8eddd1b0c725048edaaad35a8','tree':'96d4074830db3c05bc103e96cdc1104284d4a106'}
                assert descriptor['producer'] == {name:value for name,value in producer.items() if name != 'job_id'}
                assert descriptor['feature'] == selected_feature and descriptor['kind'] == kind and descriptor['inputs'] == inputs
                assert descriptor['recipe'] == recipe(kind,selected_feature) and descriptor['files'] == record['files']
                assert set(descriptor['receipts']) == set(receipts(kind,selected_feature))
                for label,item in descriptor['receipts'].items(): receipt_valid(item,label,producer,native, inputs)
                tools = descriptor['tools']
                assert tools['toolchain'] == 'nightly-2026-04-19' and isinstance(tools['rustc'],dict) and isinstance(tools['cargo'],str)
                rustc = tools['rustc']
                assert set(rustc) == {'binary','commit-hash','commit-date','host','release','LLVM version'}
                assert rustc['binary'] == 'rustc' and rustc['host'] == 'x86_64-unknown-linux-gnu' and re.fullmatch('[a-f0-9]{40}',rustc['commit-hash'])
                assert re.fullmatch('[0-9]+[.][0-9]+[.][0-9]+-nightly',rustc['release']) and datetime.date.fromisoformat(rustc['commit-date']) <= datetime.date(2026,4,19)
                assert re.fullmatch('[0-9]+[.][0-9]+[.][0-9]+',rustc['LLVM version']) and re.fullmatch(r'cargo [0-9]+[.][0-9]+[.][0-9]+-nightly \([a-f0-9]+ [0-9]{4}-[0-9]{2}-[0-9]{2}\)',tools['cargo'])
                if native:
                    assert tools['nextest'] == '0.9.146' and tools['nextest_query']['exit_code'] == 0
                    version = tools['nextest_query']['public_version']; assert isinstance(version,str) and len(version) <= 256
                    parsed = re.fullmatch(r'cargo-nextest 0\.9\.146 \((?P<short>[a-f0-9]{7,40}) (?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})\)\nrelease: 0\.9\.146\ncommit-hash: (?P<commit>[a-f0-9]{40})\ncommit-date: (?P=date)\nhost: x86_64-unknown-linux-gnu\n?',version)
                    assert parsed and parsed['commit'].startswith(parsed['short']); datetime.date.fromisoformat(parsed['date'])
                else: assert tools['bindgen'] == 'wasm-bindgen 0.2.121' and tools['wasm_target_installed'] is True
                required = {selected_feature + '.tar.zst'} if kind == 'native' else set() if kind == 'checks' else {'engine_wasm.wasm'} if kind == 'raw' else {'engine_wasm.js','engine_wasm_bg.wasm','engine_wasm.d.ts','engine_wasm_bg.wasm.d.ts'}
                snippets = set(record['files']) - required
                if kind == 'full' and selected_feature == 'enabled':
                    assert len(snippets) == 1
                    snippet = next(iter(snippets)); assert snippet.startswith('snippets/') and snippet.endswith('/src/experimental-local-worker-realm.js')
                    glue = archive.read('engine_wasm.js').decode()
                    imports = re.findall(r"import\s*\{\s*is_experimental_local_worker_realm\s*\}\s*from\s*['\"]([^'\"]+)['\"]",glue)
                    assert imports == ['./' + snippet]
                    assert archive.read(snippet) == Path('crates/engine-wasm/src/experimental-local-worker-realm.js').read_bytes()
                else: assert snippets == set()
                assert required <= set(record['files'])
                if kind == 'full': assert descriptor['raw'] == descriptors['raw'] and descriptor['raw']['tools'] == tools
                else: assert descriptor['raw'] is None
                for name,item in record['files'].items():
                    assert set(item) == {'size','sha256'} and type(item['size']) is int and item['size'] > 0 and re.fullmatch('[a-f0-9]{64}',item['sha256'])
                    contents = archive.read(name)
                    assert len(contents) == item['size'] and hashlib.sha256(contents).hexdigest() == item['sha256']
                # Extract only after every member, descriptor, producer and byte gate has passed.
                staging = temp / ('bootstrap-admitted-' + selected_feature + '-' + kind); staging.mkdir()
                for name in record['files']:
                    destination = staging / name; destination.parent.mkdir(parents=True,exist_ok=True)
                    destination.write_bytes(archive.read(name))
                (staging / 'runtime-provenance.json').write_bytes(manifest)
            descriptors[key] = descriptor
            (root / (selected_feature + '-' + kind + '-descriptor.json')).write_text(json.dumps(descriptor) + '\n')
            if kind == 'native':
                destination = temp / ('bootstrap-native-archives/' + selected_feature + '.tar.zst'); assert not destination.exists()
                shutil.copyfile(staging / (selected_feature + '.tar.zst'),destination)
            elif kind == 'full':
                destination = temp / ('bootstrap-bindgen-' + selected_feature); assert not destination.exists()
                shutil.copytree(staging,destination)
                (destination / 'runtime-provenance.json').unlink()
        (root / (feature + '-reference.json')).write_text(json.dumps(reference,separators=(',',':')) + '\n')
        (root / (feature + '-admission.json')).write_text(json.dumps({'feature':feature,'admitted':True,'full':reference['checks' if native else 'full'] is not None,
            'producer_jobs_completed':os.environ['STAGE1_REQUIRE_FULL'] == 'true','current_compile_executed':False,'product_green':False}) + '\n')
        print(json.dumps({'retained_feature_admitted':feature,'current_compile_executed':False}))
    except Exception as error:
        print(__import__('json').dumps({'error':'stage1-retained-output-refused','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)


def diagnostic_projection(raw, label, tracked, cwd):
    """Project compiler coordinates/codes only; messages and dynamic slots stay private."""
    import json
    from pathlib import Path
    value = {'status':'no-diagnostics','diagnostics':[], 'codes_withheld':0, 'locations_withheld':0}
    if len(raw) > 4*1024**2: return {**value,'status':'output-over-bound'}
    try: text = raw.decode('utf-8')
    except UnicodeError: return {**value,'status':'text-decode-failed'}
    # Fixed public lint vocabulary. Unknown lint IDs are withheld, including IDs
    # that merely resemble a lint. Compiler E/TS numeric codes contain no text.
    lint_ids = set(('dead_code unused_imports unused_variables unused_mut unused_assignments unreachable_code '
        'private_interfaces private_bounds unexpected_cfgs deprecated non_snake_case non_camel_case_types '
        'non_upper_case_globals clippy::too_many_arguments clippy::type_complexity clippy::large_enum_variant '
        'clippy::needless_return clippy::needless_borrow clippy::needless_lifetimes clippy::needless_question_mark '
        'clippy::redundant_closure clippy::redundant_pattern_matching clippy::collapsible_if clippy::collapsible_match '
        'clippy::unnecessary_map_or clippy::unnecessary_unwrap clippy::unnecessary_cast clippy::useless_conversion '
        'clippy::derivable_impls clippy::clone_on_copy clippy::new_without_default clippy::missing_const_for_thread_local '
        'clippy::missing_safety_doc clippy::not_unsafe_ptr_arg_deref clippy::manual_map clippy::manual_strip '
        'clippy::map_identity clippy::let_and_return clippy::bool_assert_comparison clippy::len_without_is_empty '
        'clippy::await_holding_refcell_ref clippy::await_holding_lock').split())
    eslint_ids = {'@typescript-eslint/no-unused-vars','@typescript-eslint/no-explicit-any',
        '@typescript-eslint/no-empty-object-type','@typescript-eslint/no-require-imports',
        'react-hooks/rules-of-hooks','react-hooks/exhaustive-deps','react-refresh/only-export-components',
        'no-unused-vars','no-undef','no-unreachable','no-constant-condition','no-empty','no-dupe-keys'}
    def location(name, line, column):
        if isinstance(name,str) and name.startswith(cwd + '/'): name = name[len(cwd)+1:]
        if name not in tracked or type(line) is not int or type(column) is not int or not 1 <= line <= 1000000 or not 1 <= column <= 1000000:
            value['locations_withheld'] += 1; return None
        lines = (Path(cwd) / name).read_text().splitlines()
        if line > len(lines) or column > len(lines[line-1]) + 1:
            value['locations_withheld'] += 1; return None
        return {'path':name,'line':line,'column':column}
    def add(level, code, place, vocabulary):
        assert level in ['error','warning','note','help','failure-note']
        numeric = r'TS[0-9]{4,5}' if label == 'client-types' else r'E[0-9]{4}' if label != 'client-lint' else r'(?!)'
        if code is not None and not (code in vocabulary or isinstance(code,str) and re.fullmatch(numeric,code)):
            value['codes_withheld'] += 1; code = None
        assert len(value['diagnostics']) < 64
        value['diagnostics'].append({'level':level,'code':code,'location':place})
    try:
        if label == 'candidate-clippy' or label in ['candidate-wasm-off-build','candidate-wasm-enabled-build']:
            for line in text.splitlines():
                if not line.startswith('{'): continue  # Cargo progress/stderr remains withheld.
                assert len(line) <= 262144
                item = json.loads(line); reason = item['reason']
                assert reason in ['compiler-message','compiler-artifact','build-script-executed','build-finished']
                if reason != 'compiler-message': continue
                message = item['message']; code = message.get('code')
                code = code.get('code') if isinstance(code,dict) else None
                spans = message['spans']; assert isinstance(spans,list) and len(spans) <= 128
                primary = [span for span in spans if span.get('is_primary') is True]
                place = location(primary[0].get('file_name'),primary[0].get('line_start'),primary[0].get('column_start')) if primary else None
                add(message['level'],code,place,lint_ids)
        elif label == 'client-types':
            for line in text.splitlines():
                found = re.fullmatch(r'([^\r\n]{1,512})\(([0-9]+),([0-9]+)\): error (TS[0-9]{4,5}):[^\r\n]*',line)
                if found:
                    name = found[1] if found[1].startswith(cwd + '/') else 'client/' + found[1]
                    add('error',found[4],location(name,int(found[2]),int(found[3])),set())
        elif label == 'client-lint':
            start = next((match.start() for match in re.finditer(r'^\[',text,re.M)),None)
            if start is not None:
                report,_ = json.JSONDecoder().raw_decode(text[start:]); assert isinstance(report,list) and len(report) <= 10000
                for file in report:
                    messages = file['messages']; assert isinstance(messages,list) and len(messages) <= 128
                    for message in messages:
                        assert type(message['severity']) is int and message['severity'] in [1,2]
                        add('error' if message['severity'] == 2 else 'warning',message.get('ruleId'),
                            location(file.get('filePath'),message.get('line'),message.get('column')),eslint_ids)
        else:
            exception_codes = {'AssertionError','AttributeError','KeyError','IndexError','ValueError','TypeError',
                'OverflowError','RuntimeError','OSError','PermissionError','FileNotFoundError',
                'IsADirectoryError','NotADirectoryError','UnicodeError','UnicodeDecodeError',
                'UnicodeEncodeError','JSONDecodeError','TOMLDecodeError','CalledProcessError',
                'TimeoutExpired','HTTPError','URLError','path-missing','permission-denied','not-a-directory'}
            tool_stages = set(('active-toolchain build-jobs cargo-format cargo-home-path cargo-identity cargo-version '
                'compiler-environment config-build-overrides config-build-type config-env-overrides config-env-type '
                'config-sections cranelift-component fixed-config-presence incremental loaded-config-file loaded-config-parse '
                'loaded-config-path nextest-version profile-environment rustc-binary rustc-commit rustc-date rustc-fields '
                'rustc-host rustc-identity rustc-llvm rustc-parse rustc-release rustc-version source-config-path '
                'source-legacy-config stack target-directory target-environment tool-manifest-write').split())
            tool_classes = set(('command-missing command-nonzero command-os-error command-permission-denied compiler-override '
                'component-missing-or-host-mismatch config-not-file config-override config-parse-failed config-shadow '
                'config-type-invalid filesystem-error fixed-config-missing host-mismatch path-missing path-permission-denied '
                'profile-mismatch required-key-missing target-override text-decode-failed tool-output-empty toolchain-mismatch '
                'unexpected-error value-parse-failed value-type-invalid version-date-mismatch version-format-invalid version-mismatch').split())
            upload_observations = 0
            for line in text.splitlines():
                if not line.startswith('{') or len(line) > 65536: continue
                try: item = json.loads(line)
                except ValueError: continue
                if not isinstance(item,dict): continue
                if label in ['stage1-off-native-pins','stage1-enabled-native-pins','stage1-enabled-checks-pins',
                        'stage1-off-raw-pins','stage1-off-full-pins','stage1-enabled-raw-pins','stage1-enabled-full-pins'] and 'upload_metadata_observation' in item:
                    assert set(item) == {'upload_metadata_observation'}
                    observation = item['upload_metadata_observation']
                    assert isinstance(observation,dict) and set(observation) == {'attempt','job_id','matches','number','job_status','status','conclusion'}
                    upload_observations += 1
                    assert type(observation['attempt']) is int and observation['attempt'] == upload_observations <= 5
                    assert type(observation['job_id']) is int and 1 <= observation['job_id'] <= 2**63 - 1
                    assert type(observation['matches']) is int and 0 <= observation['matches'] <= 1000
                    assert observation['number'] is None or type(observation['number']) is int and 1 <= observation['number'] <= 10000
                    assert observation['job_status'] in ['queued','in_progress','completed','unknown']
                    assert observation['status'] in [None,'queued','in_progress','completed','unknown']
                    assert observation['conclusion'] in [None,'success','failure','cancelled','timed_out','skipped','action_required','neutral','stale','unknown']
                    for field in ['attempt','job_id','matches','number','job_status','status','conclusion']:
                        value['diagnostics'].append({'level':'note','code':'upload-' + field.replace('_','-') + ':' +
                            ('absent' if observation[field] is None else str(observation[field])),'location':None})
                    assert len(value['diagnostics']) <= 64
                projected = item.get('diagnostic_projection')
                if isinstance(projected,dict):
                    assert set(projected) == {'status','diagnostics','codes_withheld','locations_withheld'}
                    assert projected['status'] in ['helper-exception','matched-static-portions','unknown','output-over-bound']
                    assert all(type(projected[key]) is int and 0 <= projected[key] <= 64 for key in ['codes_withheld','locations_withheld'])
                    assert isinstance(projected['diagnostics'],list) and len(projected['diagnostics']) <= 3
                    for diagnostic in projected['diagnostics']:
                        assert set(diagnostic) == {'level','code','location'} and diagnostic['level'] == 'error'
                        code = diagnostic['code']; place = diagnostic['location']
                        if code is not None and code not in exception_codes:
                            assert isinstance(code,str)
                            if code.startswith('errno:'): assert re.fullmatch(r'errno:[1-9][0-9]{0,3}',code) and int(code[6:]) <= 4095
                            else: assert re.fullmatch(r'child-exit:-?(?:0|[1-9][0-9]{0,2})',code) and -255 <= int(code[11:]) <= 255
                        if place is not None:
                            assert set(place) == {'path','line','column'} and place['path'] == 'scripts/ci/stage1-bootstrap-validation.py'
                            assert type(place['line']) is int and 1 <= place['line'] <= len(Path(__file__).read_text().splitlines()) and type(place['column']) is int and place['column'] == 1
                        assert len(value['diagnostics']) < 64
                        value['diagnostics'].append({'level':'error','code':code,'location':place})
                    value['codes_withheld'] += projected['codes_withheld']; value['locations_withheld'] += projected['locations_withheld']
                if label == 'stage1-rust-tools' and item.get('error') == 'native-off-tools-refused':
                    assert item.get('stage') in tool_stages and item.get('classification') in tool_classes
                    value['diagnostics'].extend({'level':'error','code':code,'location':None} for code in [
                        'native-tools-stage:' + item['stage'],'native-tools-class:' + item['classification']])
                    query = item['nextest_query']; number = query['exit_code']
                    assert number is None or type(number) is int and -255 <= number <= 255
                    if number is not None: value['diagnostics'].append({'level':'error','code':'child-exit:' + str(number),'location':None})
                    assert len(value['diagnostics']) <= 64
        value['status'] = 'matched' if value['diagnostics'] else 'no-diagnostics'
    except Exception:
        # Do not export a partial projection after a malformed/unbounded structure.
        value = {'status':'parse-failed','diagnostics':[],'codes_withheld':0,'locations_withheld':0}
    return value


def safe_result():
    import json, os, subprocess, sys
    from pathlib import Path
    code = int(sys.argv[2]); label = sys.argv[3]
    assert 0 <= code <= 255 and re.fullmatch('[a-z0-9]+(?:-[a-z0-9]+)*',label)
    paths = []
    if label in ['candidate-native-off-archive','candidate-native-enabled-archive']:
        paths = ['bootstrap-native-archives/' + ('off' if label == 'candidate-native-off-archive' else 'enabled') + '.tar.zst']
    elif label in ['candidate-wasm-off-build','candidate-wasm-enabled-build']: paths = ['bootstrap-wasm-target/wasm32-unknown-unknown/wasm-dev/engine_wasm.wasm']
    elif label in ['candidate-wasm-off-bindgen','candidate-wasm-enabled-bindgen']:
        feature = 'off' if label == 'candidate-wasm-off-bindgen' else 'enabled'
        paths = ['bootstrap-bindgen-' + feature + '/' + name for name in ['engine_wasm.js','engine_wasm_bg.wasm','engine_wasm.d.ts','engine_wasm_bg.wasm.d.ts']]
    elif label == 'candidate-declarations':
        paths = ['bootstrap-bindgen-off/engine_wasm.d.ts','bootstrap-bindgen-enabled/engine_wasm.d.ts']
    root = Path(os.environ['MANUAL_EVIDENCE'])
    value = {'label':label,'command_exit_code':code,'process_exit_code':None,'collector_exit_code':code,
        'projection_exit_code':0,'classification':'passed' if code == 0 else 'command-failed',
        'known_files':{},'diagnostic_projection':{'status':'not-applicable','diagnostics':[], 'codes_withheld':0,'locations_withheld':0}}
    if label in ['client-adapter-tests','candidate-native-off-tests','candidate-native-enabled-tests']:
        value['runner_exit_code'] = None
    try:
        value['known_files'] = {name:(Path(os.environ['RUNNER_TEMP']) / name).is_file() for name in paths}
        receipt = json.loads((root / (label + '.json')).read_text())
        assert receipt['label'] == label and receipt['effective_exit'] == code
        actual = receipt['exit_code']; assert actual is None or type(actual) is int and -255 <= actual <= 255
        value['process_exit_code'] = actual
        if type(actual) is int and actual < 0: value['classification'] = 'process-signalled'
        with (root / (label + '.log')).open('rb') as stream: raw = stream.read(4*1024**2 + 1)
        # Reuse fixed native OS causes and the shared helpers' fixed refusal codes.
        # Nothing from a raw line or arbitrary JSON value is copied to the result.
        fixed_errors = {'stage1-source-refused','stage1-retained-ref-invalid','runtime-provenance-mismatch',
            'stage1-public-package-refused','stage1-upload-metadata-refused','stage1-retained-output-refused',
            'stage1-raw-input-refused','stage1-baseline-source-refused','stage1-producer-current-tool-mismatch','adapter-report-unavailable',
            'adapter-summary-save-failed','native-off-reuse-observation-save-failed','native-off-tools-refused','stage1-helper-failed'}
        value['static_causes'] = []
        native_tools_failure = None
        if len(raw) <= 4*1024**2:
            for literal,category in [(b'No such file or directory (os error 2)','path-missing'),
                (b'Permission denied (os error 13)','permission-denied'),(b'Not a directory (os error 20)','not-a-directory')]:
                if literal in raw: value['static_causes'].append(category)
            for line in raw.splitlines():
                if line.startswith(b'{') and len(line) <= 1024:
                    try:
                        item = json.loads(line); error = item.get('error')
                        if label == 'stage1-rust-tools' and error == 'native-off-tools-refused': native_tools_failure = item
                    except Exception: continue
                    if isinstance(error,str) and error in fixed_errors: value['static_causes'].append(error)
            value['static_causes'] = sorted(set(value['static_causes']))
        if label in ['client-adapter-tests','candidate-native-off-tests','candidate-native-enabled-tests'] and len(raw) <= 4*1024**2:
            # The existing collectors print their safe result even if saving fails.
            # Retain only their actual scalar exit fields, never application stdout.
            for line in raw.splitlines():
                if not line.startswith(b'{') or len(line) > 65536: continue
                try:
                    item = json.loads(line)
                    observation = item['native_off_reuse_observation'] if label != 'client-adapter-tests' else item
                    runner = observation['runner_exit_code']
                    assert runner is None or type(runner) is int and -255 <= runner <= 255
                    value['runner_exit_code'] = runner
                    if label != 'client-adapter-tests':
                        collector = observation['collector_exit_code']
                        assert collector is None or type(collector) is int and 0 <= collector <= 255
                        value['collector_exit_code'] = collector
                        if item['observation_saved'] is not True: value['projection_exit_code'] = 1
                except Exception: continue
        compiler = label in ['candidate-clippy','candidate-wasm-off-build','candidate-wasm-enabled-build','client-types','client-lint']
        tracked = set(subprocess.check_output(['git','ls-files','-z']).decode().split('\0')) - {''} if compiler else set()
        value['diagnostic_projection'] = diagnostic_projection(raw,label,tracked,str(Path.cwd()))
        if value['diagnostic_projection']['status'] not in ['matched','no-diagnostics']: value['projection_exit_code'] = 1
        if native_tools_failure is not None:
            item = native_tools_failure
            assert value['diagnostic_projection']['status'] == 'matched'
            assert item['native_off_tools_admitted'] is False and type(item['tool_manifest_saved']) is bool
            assert item['persistence_classification'] in [None,'path-permission-denied','path-missing','filesystem-error','persistence-failed']
            query = item['nextest_query']; assert set(query) == {'exit_code','public_version'}
            version = query['public_version']
            if version is not None:
                assert isinstance(version,str) and len(version) <= 256
                parsed = re.fullmatch(r'cargo-nextest 0\.9\.146 \((?P<short>[a-f0-9]{7,40}) (?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})\)\nrelease: 0\.9\.146\ncommit-hash: (?P<commit>[a-f0-9]{40})\ncommit-date: (?P=date)\nhost: x86_64-unknown-linux-gnu\n?',version)
                assert parsed and parsed['commit'].startswith(parsed['short']); datetime.date.fromisoformat(parsed['date'])
            value['native_tools_failure'] = {key:item[key] for key in ['stage','classification','nextest_query','tool_manifest_saved','persistence_classification']}
    except Exception as error:
        value['projection_exit_code'] = 1
        value['diagnostic_projection'] = helper_exception(error)
        value['diagnostic_projection']['status'] = 'receipt-or-collector-unavailable'
    if label in ['candidate-enabled-browser','candidate-off-browser']:
        stages = ['runtime-copy','server-start','server-ready','served-identity','source-identity','session-create',
            'session-timeouts','navigation','page-completion','terminal-projection','terminal-save','terminal-gate']
        try:
            stage = sys.argv[4] if len(sys.argv) == 5 else json.loads((root / (label + '-result.json')).read_text())['browser_stage']
            assert stage in stages
            value['browser_stage'] = stage
            # Inside the browser EXIT trap the guard has not finished its receipt.
            if len(sys.argv) == 5 and not (root / (label + '.json')).exists():
                value['projection_exit_code'] = 0; value['diagnostic_projection']['status'] = 'awaiting-guard-receipt'
        except Exception as error:
            value['browser_stage'] = None; value['projection_exit_code'] = 1
            value['diagnostic_projection'] = helper_exception(error)
    print(json.dumps(value))
    try:
        (root / (label + '-result.json')).write_text(json.dumps(value) + '\n')
    except Exception as error:
        print(json.dumps({'error':'stage1-safe-result-save-failed','save_stage':'result',
            'diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)
    raise SystemExit(value['projection_exit_code'])


def raw_input():
    import hashlib, json, os, shutil, stat
    from pathlib import Path
    try:
        feature = os.environ['STAGE1_FEATURE']; assert feature in ['off','enabled']
        root = Path(os.environ['MANUAL_EVIDENCE']); temp = Path(os.environ['RUNNER_TEMP'])
        descriptor = json.loads((root / (feature + '-raw-descriptor.json')).read_text())
        source = temp / ('bootstrap-admitted-' + feature + '-raw/engine_wasm.wasm')
        info = source.lstat(); expected = descriptor['files']['engine_wasm.wasm']
        assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == expected['size']
        with source.open('rb') as stream: assert hashlib.file_digest(stream,'sha256').hexdigest() == expected['sha256']
        destination = temp / 'bootstrap-wasm-target/wasm32-unknown-unknown/wasm-dev/engine_wasm.wasm'
        destination.parent.mkdir(parents=True,exist_ok=True)
        if destination.exists(): assert stat.S_ISREG(destination.lstat().st_mode) and destination.stat().st_nlink == 1
        shutil.copyfile(source,destination)
        with destination.open('rb') as stream: assert hashlib.file_digest(stream,'sha256').hexdigest() == expected['sha256']
        print('{"retained_raw_at_existing_bindgen_input":true,"current_compile_executed":false}')
    except Exception as error:
        print(__import__('json').dumps({'error':'stage1-raw-input-refused','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)


def baseline_identity():
    import os, subprocess
    from pathlib import Path
    try:
        def git(*args): return subprocess.check_output(['git','-C','../baseline-source',*args],text=True).strip()
        assert git('rev-parse','HEAD') == os.environ['BOOTSTRAP_BASE_SHA'] == '8fcd0f33451058f55b110e707d50497545763615'
        assert git('rev-parse','HEAD^{tree}') == os.environ['BOOTSTRAP_BASE_TREE'] == '85f6682f6a2db68e5a67e23719f2126e3d241133'
        assert git('status','--porcelain') == ''
        root = Path(os.environ['MANUAL_EVIDENCE'])
        (root / 'baseline-source.txt').write_text(git('rev-parse','HEAD','HEAD^{tree}') + '\n')
        print('{"baseline_identity_admitted":true,"baseline_build_executed":false}')
    except Exception as error:
        print(__import__('json').dumps({'error':'stage1-baseline-source-refused','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)


def tools_match():
    import json, os
    from pathlib import Path
    try:
        root = Path(os.environ['MANUAL_EVIDENCE']); actual = json.loads((root / 'tool-manifest.json').read_text())
        native = json.loads((root / 'enabled-native-descriptor.json').read_text())
        off = json.loads((root / 'off-native-descriptor.json').read_text())
        checks = json.loads((root / 'enabled-checks-descriptor.json').read_text())
        selected = {name:actual[name] for name in ['toolchain','rustc','cargo','nextest','nextest_query']}
        assert off['tools'] == native['tools'] == checks['tools'] == selected
        for feature in ['off','enabled']:
            descriptor = json.loads((root / (feature + '-full-descriptor.json')).read_text())
            assert all(descriptor['tools'][name] == actual[name] for name in ['toolchain','rustc','cargo'])
        print('{"producer_and_current_tools_match":true}')
    except Exception as error:
        print(__import__('json').dumps({'error':'stage1-producer-current-tool-mismatch','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)


def native_tests():
    import ast, hashlib, json, locale, os, re, subprocess, sys
    from pathlib import Path
    # ExpectedError::display_to_stderr and the runner errors at cargo-nextest-0.9.146.
    # Only these static portions are saved; every dynamic slot is withheld.
    def project(raw):
        value = {'category': 'unknown', 'header': None, 'causes': [], 'projection_status': 'unknown'}
        if len(raw) > 65536:
            value['projection_status'] = 'output-over-bound'; return value
        try: output = raw.decode('utf-8')
        except UnicodeError:
            value['projection_status'] = 'text-decode-failed'; return value
        output = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output)
        headers = [
            (r'profile `[^`\n]{1,256}` not found \(known profiles: [^\n]{0,256}\)', 'profile', 'profile `<withheld>` not found (known profiles: <withheld>)'),
            (r'failed to parse nextest config at `[^`\n]{1,256}`(?: provided by tool `[^`\n]{1,128}`)?', 'config', 'failed to parse nextest config at `<withheld>`'),
            (r'error extracting archive `[^`\n]{1,256}`', 'archive', 'error extracting archive `<withheld>`'),
            (r'failed to autodetect archive format for [^\n]{1,256}', 'archive', 'failed to autodetect archive format for <withheld>'),
            (r'argument --(?:workspace-remap|target-dir-remap|build-dir-remap) specified `[^`\n]{1,256}` that couldn\x27t be read', 'path', "argument <withheld> specified `<withheld>` that couldn't be read"),
            (r'workspace root manifest at [^\n]{1,256} does not exist', 'path', 'workspace root manifest at <withheld> does not exist'),
            (r'workspace root `[^`\n]{1,256}` is invalid', 'path', 'workspace root `<withheld>` is invalid'),
            (r'failed to create store dir at `[^`\n]{1,256}`', 'path', 'failed to create store dir at `<withheld>`'),
            (r'error reading Cargo metadata from file `[^`\n]{1,256}`', 'archive', 'error reading Cargo metadata from file `<withheld>`'),
            (r'error parsing Rust build metadata', 'archive', 'error parsing Rust build metadata'),
            (r'failed to build test runner', 'runner', 'failed to build test runner'),
            (r'the host platform could not be detected', 'runner', 'the host platform could not be detected'),
            (r'failed to get current executable', 'runner', 'failed to get current executable'),
        ]
        causes = [
            (r'error creating Tokio runtime', 'runner', 'error creating Tokio runtime'),
            (r'error setting up signals', 'runner', 'error setting up signals'),
            (r'(remapped (?:workspace root|target directory|build directory)) `[^`\n]{1,256}` failed to canonicalize', 'path', 'remapped <withheld> failed to canonicalize'),
            (r'(remapped (?:workspace root|target directory|build directory)) `[^`\n]{1,256}` is not a directory', 'path', 'remapped <withheld> is not a directory'),
            (r'error resolving the configuration path', 'config', 'error resolving the configuration path'),
            (r'error deserializing platform from build metadata', 'archive', 'error deserializing platform from build metadata'),
            (r'the host platform could not be determined', 'runner', 'the host platform could not be determined'),
            (r'unsupported features in the build metadata: [^\n]{1,256}', 'archive', 'unsupported features in the build metadata: <withheld>'),
            (r'error joining dynamic library paths for [^\n]{1,256}', 'lib', 'error joining dynamic library paths for <withheld>'),
            (r'No such file or directory \(os error 2\)', 'path', 'No such file or directory (os error 2)'),
            (r'Permission denied \(os error 13\)', 'path', 'Permission denied (os error 13)'),
            (r'Not a directory \(os error 20\)', 'path', 'Not a directory (os error 20)'),
            (r'Resource temporarily unavailable \(os error 11\)', 'runner', 'Resource temporarily unavailable (os error 11)'),
        ]
        lines = output.splitlines()
        for line in lines[:128]:
            if len(line) > 512: continue
            if line.startswith('error: '):
                for pattern, category, public in headers:
                    if re.fullmatch(pattern, line[7:]):
                        value.update(category=category, header=public, projection_status='matched-static-portions'); break
                break
        if value['header'] is not None:
            for index, line in enumerate(lines[:128]):
                if line != 'Caused by:' or index + 1 >= len(lines): continue
                cause = lines[index + 1]
                if not cause.startswith('  ') or len(cause) > 512: continue
                for pattern, category, public in causes:
                    if re.fullmatch(pattern, cause[2:]):
                        value['causes'].append({'category': category, 'static_text': public}); break
                if len(value['causes']) == 4: break
        return value
    artifact = os.environ['BOOTSTRAP_NATIVE_ARTIFACT']; assert artifact in ['off','enabled']
    diagnostic = {'runner_exit_code': None, 'collector_exit_code': None, 'runner_returned': False,
        'launch_classification': None, 'error_projection': project(b''), 'product_green': False,
        'setup_context': {'stage': 'collector-admission',
            'archive_relative_path': 'bootstrap-native-archives/' + artifact + '.tar.zst', 'extract_relative_path': 'bootstrap-native-' + artifact,
            'runner_temp_is_directory': None, 'destination_existed_before': None, 'destination_exists_after': None,
            'cwd_matches_candidate_source': None}}
    original_run = subprocess.run; calls = 0; saved = False
    try:
        runner_temp = Path(os.environ['RUNNER_TEMP']); destination = runner_temp / ('bootstrap-native-' + artifact)
        context = diagnostic['setup_context']
        context.update(runner_temp_is_directory=runner_temp.is_dir(), destination_existed_before=destination.exists(),
            cwd_matches_candidate_source=Path.cwd() == Path(os.environ['GITHUB_WORKSPACE']) / 'candidate-source')
        native = (Path(os.environ['RUNNER_TEMP']) / 'bootstrap-native-off-collector.py').read_text()
        assert hashlib.sha256(native.encode()).hexdigest() == 'cbbd22b60f2f4b6630748bb277fe75c89d4df68ef1edc96e76fe008db0a223e4'
        tree = ast.parse(native)
        invocations = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and
            isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and
            node.func.value.id == 'subprocess' and node.func.attr == 'run']
        assert len(invocations) == 1
        def observe(argv, **kwargs):
            nonlocal calls
            calls += 1
            assert calls == 1 and argv[:3] == ['cargo-nextest', 'nextest', 'run']
            assert kwargs == {'stdout': subprocess.PIPE, 'stderr': subprocess.STDOUT, 'text': True}
            # Capture bytes only to latch the actual returned code before the original text decode.
            result = original_run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            diagnostic.update(runner_exit_code=result.returncode, runner_returned=True)
            diagnostic['error_projection'] = project(result.stdout)
            encoding = 'utf-8' if sys.flags.utf8_mode else locale.getencoding()
            output = result.stdout.decode(encoding).replace('\r\n', '\n').replace('\r', '\n')
            return subprocess.CompletedProcess(result.args, result.returncode, output, result.stderr)
        context['stage'] = 'extract-destination-creation'
        try: destination.mkdir()
        finally: context['destination_exists_after'] = destination.exists()
        context['stage'] = 'collector-execution'
        subprocess.run = observe
        exec(compile(native, '<original-native-off-collector>', 'exec'), {})
    except SystemExit as error:
        diagnostic['collector_exit_code'] = error.code if type(error.code) is int else 1
    except FileNotFoundError: diagnostic['launch_classification'] = 'path-or-command-missing'
    except PermissionError: diagnostic['launch_classification'] = 'path-or-command-permission-denied'
    except UnicodeError: diagnostic['launch_classification'] = 'text-decode-failed'
    except Exception as error:
        diagnostic['launch_classification'] = 'observer-or-collector-refused'
        print(json.dumps({'diagnostic_projection':helper_exception(error)}))
    finally:
        subprocess.run = original_run
        try:
            (Path(os.environ['MANUAL_EVIDENCE']) / ('runner-' + artifact + '-error.json')).write_text(json.dumps(diagnostic) + '\n')
            saved = True
        except Exception as error:
            print(json.dumps({'error':'native-off-reuse-observation-save-failed',
                'diagnostic_projection':helper_exception(error)}))
        print(json.dumps({'native_off_reuse_observation': diagnostic, 'observation_saved': saved}))
    raise SystemExit(0 if saved and diagnostic['collector_exit_code'] == 0 and diagnostic['launch_classification'] is None else 1)


def declarations():
    import json, os, re
    from pathlib import Path
    root = Path(os.environ['RUNNER_TEMP'])
    off_bytes = (root / 'bootstrap-bindgen-off/engine_wasm.d.ts').read_bytes(); off = off_bytes.decode('utf-8'); on = (root / 'bootstrap-bindgen-enabled/engine_wasm.d.ts').read_text()
    names = lambda text: set(re.findall(r'^export function ([A-Za-z0-9_]+)\(', text, re.M))
    expected = {'initialize_experimental_local_game', 'experimental_local_actor'}
    passed = (off_bytes == Path('client/src/wasm/engine_wasm.d.ts').read_bytes() and names(on) - names(off) == expected
        and not names(off) - names(on) and not names(off) & expected
        and 'export function initialize_experimental_local_game(request: any): any;' in on
        and 'export function experimental_local_actor(): number | undefined;' in on)
    path = Path(os.environ['MANUAL_EVIDENCE']) / 'red-adjudication.json'
    value = json.loads(path.read_text()); value['declarations_verified'] = passed; path.write_text(json.dumps(value) + '\n')
    print(json.dumps({'declarations_verified': passed})); raise SystemExit(0 if passed else 1)


def adapter_tests():
    import json, os, subprocess
    from pathlib import Path
    summary = {'runner_exit_code': None, 'report_valid': False, 'all_selected_tests_passed': False}
    result = None
    try:
        result = subprocess.run([
            'pnpm', '--dir', 'client', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts',
            '--pool=forks', '--isolate', '--maxWorkers=1', '--no-file-parallelism',
            '--coverage.enabled=false', '--reporter=json', '--silent=true',
            'src/adapter/__tests__/engine-worker.test.ts',
            'src/adapter/__tests__/engine-worker-client.test.ts',
            'src/adapter/__tests__/wasm-adapter.test.ts',
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8', errors='replace',
            env={**os.environ, 'NO_COLOR': '1', 'FORCE_COLOR': '0'})
        summary['runner_exit_code'] = result.returncode
        summary['diagnostic_projection'] = {'status':'unknown','diagnostics':[], 'codes_withheld':0,'locations_withheld':0}
        if len(result.stderr) <= 65536:
            for literal, code in [('No such file or directory (os error 2)','path-missing'),
                ('Permission denied (os error 13)','permission-denied'),('Not a directory (os error 20)','not-a-directory')]:
                if literal in result.stderr:
                    summary['diagnostic_projection']['diagnostics'].append({'level':'error','code':code,'location':None})
            if summary['diagnostic_projection']['diagnostics']: summary['diagnostic_projection']['status'] = 'matched-static-portions'
        else: summary['diagnostic_projection']['status'] = 'output-over-bound'
        report = json.loads(result.stdout)
        statuses = [case['status'] for file in report['testResults'] for case in file['assertionResults']]
        counts = {status: statuses.count(status) for status in ['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled']}
        valid = (len(report['testResults']) == 3 and len(statuses) > 0 and
                 sum(counts.values()) == len(statuses) == report['numTotalTests'] and
                 counts['passed'] == report['numPassedTests'] and counts['failed'] == report['numFailedTests'])
        if valid:
            summary.update(report_valid=True, tests_total=len(statuses),
                           tests_executed=counts['passed'] + counts['failed'],
                           tests_passed=counts['passed'], tests_failed=counts['failed'],
                           tests_skipped=counts['skipped'], tests_pending=counts['pending'],
                           tests_todo=counts['todo'], tests_disabled=counts['disabled'],
                           all_selected_tests_passed=result.returncode == 0 and counts['passed'] == len(statuses))
    except Exception as error:
        summary['error'] = 'adapter-report-unavailable'
        summary['diagnostic_projection'] = helper_exception(error)
    code = result.returncode if result is not None else 1
    if code == 0 and not summary['all_selected_tests_passed']:
        code = 1
    try:
        Path(os.environ['MANUAL_EVIDENCE'], 'adapter-assertions.json').write_text(json.dumps(summary) + '\n')
    except Exception as error:
        summary['error'] = 'adapter-summary-save-failed'
        summary['diagnostic_projection'] = helper_exception(error)
        if code == 0: code = 1
    print(json.dumps(summary))
    raise SystemExit(code if code >= 0 else 128 - code)


def copy_runtime():
    import os, shutil
    from pathlib import Path
    for name in ['engine_wasm.js','engine_wasm_bg.wasm']:
        shutil.copyfile(Path(os.environ['RUNNER_TEMP']) / 'bootstrap-bindgen-off' / name, Path('client/src/wasm') / name)
    print('{"admitted_ignored_runtime_copied":true}')


def green():
    import hashlib, json, os
    from pathlib import Path
    root = Path(os.environ['MANUAL_EVIDENCE'])
    def load(name):
        try: return json.loads((root / name).read_text())
        except Exception: return {}
    value = load('red-adjudication.json'); terminals = load('baseline-terminal.json'); adapter = load('adapter-assertions.json')
    complete = value.get('declarations_verified') is True
    source = load('source-manifest.json')
    complete &= source.get('product_equal') is True and source.get('validation_sha') == os.environ['GITHUB_SHA']
    complete &= source.get('source_sha') == 'a7402dda9062ede8eddd1b0c725048edaaad35a8' and source.get('source_tree') == '96d4074830db3c05bc103e96cdc1104284d4a106'
    complete &= source.get('guard_sha256') == os.environ['STAGE1_GUARD_SHA256']
    import datetime, re
    inputs = source.get('input_sha256',{})
    producer_commands = {}
    for feature in ['native-off','native','off','enabled']:
        admission = load(feature + '-admission.json')
        native = feature in ['native-off','native']
        complete &= admission.get('admitted') is True and admission.get('feature') == feature
        complete &= admission.get('full') is (feature != 'native-off') and admission.get('producer_jobs_completed') is (feature != 'native-off')
        reference = load(feature + '-reference.json')
        required = ['archive'] if feature == 'native-off' else ['archive','checks'] if native else ['raw','full']
        complete &= set(reference) == ({'archive','checks'} if native else {'raw','full'}) and all(reference.get(key) for key in required)
        if feature == 'native-off': complete &= reference.get('checks') is None
        for key in required:
            kind = 'native' if key == 'archive' else key
            selected_feature = 'off' if feature == 'native-off' else 'enabled' if native else feature
            descriptor = load(selected_feature + '-' + kind + '-descriptor.json')
            complete &= descriptor.get('product') == {'sha':'a7402dda9062ede8eddd1b0c725048edaaad35a8','tree':'96d4074830db3c05bc103e96cdc1104284d4a106'}
            producer_commands[selected_feature + '-' + kind] = descriptor.get('receipts',{})
            try:
                assert descriptor.get('recipe') == recipe(kind,selected_feature)
                if feature == 'native-off':
                    assert descriptor.get('kind') == 'native' and descriptor.get('feature') == 'off' and descriptor.get('raw') is None
                    assert reference['archive']['kind'] == 'native' and reference['archive']['feature'] == 'off'
                    files = descriptor['files']; assert files == reference['archive']['files'] and set(files) == {'off.tar.zst'}
                    item = files['off.tar.zst']
                    assert set(item) == {'size','sha256'} and type(item['size']) is int and item['size'] > 0 and re.fullmatch('[a-f0-9]{64}',item['sha256'])
                assert set(descriptor.get('receipts',{})) == set(receipts(kind,selected_feature))
                for label,item in descriptor['receipts'].items(): receipt_valid(item,label,descriptor['producer'],native, inputs)
            except Exception: complete = False
            for label,item in descriptor.get('receipts',{}).items():
                complete &= item.get('label') == label and item.get('exit_code') == item.get('effective_exit') == 0
                complete &= item.get('stop_reason') is None and item.get('source_unchanged') is True
                complete &= item.get('guard') == {'working_set_bytes':13*1024**3,'disk_free_min_bytes':4*1024**3,'sample_interval_seconds':1,
                    'timeout_seconds':2400 if label in ['candidate-wasm-off-build','candidate-wasm-enabled-build'] else 1500}
                complete &= item.get('environment',{}).get('CARGO_PROFILE_DEV_DEBUG') == (None if label == 'stage1-source-before' else '0')
    for feature in ['off','enabled']:
        runner = load('runner-' + feature + '-error.json')
        complete &= runner.get('runner_exit_code') == runner.get('collector_exit_code') == 0 and runner.get('runner_returned') is True and runner.get('launch_classification') is None
        diagnostic = value.get('native_diagnostics',{}).get(feature,{})
        shape = diagnostic.get('output_shape',{})
        complete &= shape.get('start_marker') is True and shape.get('summary_marker') is True and shape.get('error_marker') is False
        complete &= shape.get('pass_identity_match') is True and shape.get('summary_pass_match') is True
        complete &= shape.get('status_lines') == {'PASS':10 if feature == 'off' else 16,'FAIL':0,'ABORT':0,'TIMEOUT':0,'XFAIL':0}

    complete &= value.get('native_tests') == {'off': {'selected': 10, 'executed': 10, 'passed': True}, 'enabled': {'selected': 16, 'executed': 16, 'passed': True}}
    complete &= adapter.get('report_valid') is True and adapter.get('all_selected_tests_passed') is True and adapter.get('runner_exit_code') == 0
    complete &= all(adapter.get(key) == 102 for key in ['tests_total', 'tests_executed', 'tests_passed'])
    complete &= all(adapter.get(key) == 0 for key in ['tests_failed', 'tests_skipped', 'tests_pending', 'tests_todo', 'tests_disabled'])
    labels = ['stage1-source-before', 'stage1-selection', 'stage1-baseline-identity', 'baseline-source-before', 'stage1-native-off-admission', 'stage1-native-admission', 'stage1-off-admission', 'stage1-enabled-admission', 'stage1-rust-tools', 'stage1-current-tools-match', 'candidate-native-off-tests', 'candidate-native-enabled-tests', 'candidate-declarations', 'hosted-tools', 'client-dependencies', 'baseline-runtime-copy', 'client-types', 'client-lint', 'client-protocol', 'client-adapter-tests', 'candidate-enabled-browser', 'candidate-off-browser', 'stage1-source-after', 'baseline-source-after']
    records = {}
    for label in labels:
        record = load(label + '.json'); records[label] = record
        before = label in ['stage1-source-before', 'stage1-selection', 'stage1-baseline-identity', 'baseline-source-before', 'stage1-native-off-admission', 'stage1-native-admission', 'stage1-off-admission', 'stage1-enabled-admission']
        expected_sha = os.environ['BOOTSTRAP_BASE_SHA'] if label.startswith('baseline-source-') else os.environ['MANUAL_EXPECTED_SOURCE_SHA']
        expected_argv = ['true'] if label in ['stage1-source-before','baseline-source-before','stage1-source-after','baseline-source-after'] else ['bash','-euo','pipefail']
        if label in ['candidate-enabled-browser','candidate-off-browser']:
            expected_argv = ['bash','-euo','pipefail','../validation-source/scripts/ci/stage1-bootstrap-browser.sh']
        modes = {'stage1-selection':'select','stage1-baseline-identity':'baseline-identity',
            'stage1-native-off-admission':'admit',
            'stage1-native-admission':'admit','stage1-off-admission':'admit','stage1-enabled-admission':'admit',
            'stage1-rust-tools':'native-tools','stage1-current-tools-match':'tools-match',
            'candidate-native-off-tests':'native-tests','candidate-native-enabled-tests':'native-tests',
            'candidate-declarations':'declarations','baseline-runtime-copy':'copy-runtime','client-adapter-tests':'adapter-tests'}
        if label in modes: expected_argv = ['python3','../validation-source/scripts/ci/stage1-bootstrap-validation.py',modes[label]]
        client_commands = {'client-dependencies':'pnpm --dir client install --frozen-lockfile',
            'client-types':'pnpm --dir client run type-check','client-lint':'pnpm --dir client run lint --format json',
            'client-protocol':'pnpm --dir client run protocol:check'}
        if label in client_commands: expected_argv = ['bash','-euo','pipefail','-c',client_commands[label]]
        complete &= bool(record and record.get('source_sha') == expected_sha and record.get('source_tree') == (os.environ['BOOTSTRAP_BASE_TREE'] if label.startswith('baseline-source-') else '96d4074830db3c05bc103e96cdc1104284d4a106') and record.get('label') == label
            and record.get('event_sha') == os.environ['GITHUB_SHA'] and record.get('argv') == expected_argv
            and record.get('input_sha256') == {key:source.get('input_sha256',{}).get(key) for key in ['Cargo.lock','client/pnpm-lock.yaml','rust-toolchain.toml']}
            and record.get('exit_code') == record.get('effective_exit') == 0 and record.get('stop_reason') is None and record.get('source_unchanged') is True
            and record.get('environment', {}).get('CARGO_PROFILE_DEV_DEBUG') == (None if before else '0')
            and record.get('environment', {}).get('CARGO_TARGET_DIR') == os.environ['CARGO_TARGET_DIR']
            and record.get('environment', {}).get('CARGO_BUILD_JOBS') == '1' and record.get('environment', {}).get('CARGO_INCREMENTAL') == '0'
            and record.get('environment', {}).get('RUST_MIN_STACK') == '16777216'
            and record.get('guard') == {'working_set_bytes':13*1024**3,'disk_free_min_bytes':4*1024**3,'sample_interval_seconds':1,'timeout_seconds':1500})
    for artifact in ['enabled','off']:
        terminal = terminals.get(artifact, {}); rows = terminal.get('rows', [])
        extra = ['experimental_local_admission','experimental_strict_requests','experimental_lifecycle','experimental_privacy_closed','experimental_realm_fallback'] if artifact == 'enabled' else ['feature_off_refusal','experimental_realm_fallback']
        complete &= terminal.get('status') == 'pass' and terminal.get('reason') == 'candidate-green' and terminal.get('artifact') == artifact
        complete &= [row.get('name') for row in rows] == ['artifact_identity','ordinary_initializer_preservation','ordinary_worker_action','experimental_availability',*extra]
        complete &= all(row.get('status') == 'pass' and all(row.get(key) is None for key in ['error','caseId','stage']) for row in rows)
        if len(rows) != 4 + len(extra): complete = False; continue
        complete &= rows[3].get('evidence') == {'initialize_experimental_local_game': artifact == 'enabled','experimental_local_actor': artifact == 'enabled'}
        controls = rows[1].get('evidence', [])
        names = {control.get('name') for control in controls}
        complete &= len(controls) == 90 and len(names) == 90 and 'invalid-case' not in names
        complete &= all(control.get('status') == 'pass' for control in controls)
        for control in controls:
            assertions = control.get('evidence', {})
            reach_guard = assertions.get('reachGuard')
            complete &= reach_guard is None or reach_guard in names
            if reach_guard is None:
                complete &= all(assertions.get(key) is True for key in [
                    'initializationAccepted', 'stateInstalled', 'replayInstalled'])
            else:
                complete &= all(assertions.get(key) is True for key in [
                    'refusalClassMatched', 'typedDiscriminatorsMatched', 'residentPreserved'])
            name = control.get('name', '')
            if name.rsplit('.', 1)[-1] in ['omitted_defaults', 'null_defaults', 'undeclared_four_seats', 'malformed_match_fallback']:
                complete &= all(assertions.get(key) is True for key in [
                    'defaultsMatched', 'viewerRngRedacted', 'trustedSeedPreserved'])
            if name.startswith('production-worker.') and name.rsplit('.', 1)[-1] in ['cedh_bracket_refusal', 'occupied_direction']:
                complete &= assertions.get('clientCodeMatched') is True
        complete &= rows[2].get('evidence') == {
            'ordinaryDecisionReached': True, 'humanDecisionIssued': True, 'engineIssuedAction': True,
            'snapshotChanged': True, 'replayRecordedOnce': True, 'recordedActionCount': 1}
        observed = rows[0].get('evidence', {}); supplied = observed.get('supplied', {})
        complete &= supplied.get('candidate_sha') == os.environ['MANUAL_EXPECTED_SOURCE_SHA'] and supplied.get('candidate_tree') == records['stage1-source-before'].get('source_tree')
        complete &= supplied.get('baseline_sha') == os.environ['BOOTSTRAP_BASE_SHA'] and supplied.get('baseline_tree') == os.environ['BOOTSTRAP_BASE_TREE']
        artifact_dir = Path(os.environ['RUNNER_TEMP']) / ('bootstrap-bindgen-' + artifact)
        manifest = load(artifact + '-full-descriptor.json')
        complete &= all((artifact_dir / name).is_file() and (artifact_dir / name).stat().st_size == item.get('size')
            and hashlib.sha256((artifact_dir / name).read_bytes()).hexdigest() == item.get('sha256') for name,item in manifest.get('files',{}).items())
        complete &= observed.get('wasmHash') == hashlib.sha256((artifact_dir / 'engine_wasm_bg.wasm').read_bytes()).hexdigest()
        complete &= supplied.get('glue_sha256') == hashlib.sha256((artifact_dir / 'engine_wasm.js').read_bytes()).hexdigest()
        expected_keys = {'experimental_local_admission': ['explicitAdmission', 'ordinaryNeverAdmits', 'oldResidentPreserved', 'verifierReadOnly'], 'experimental_strict_requests': ['adapterStrict', 'rawWorkerStrict', 'wasmBoundaryStrict', 'priorOwnerPreserved'], 'experimental_lifecycle': ['failedRestorePreserved', 'checkedRestoreRevoked', 'ordinaryRevoked', 'postureRevoked', 'hostRefused', 'resetRevoked'], 'experimental_privacy_closed': ['privateWireClean', 'manualMutationClosed', 'laterExportsAbsent'], 'experimental_realm_fallback': ['mainThreadRefused', 'fallbackOrdinaryAction', 'fallbackExperimentalRefused'], 'feature_off_refusal': ['refusalPreserved', 'verifierNull', 'ordinaryWorkerLoaded']}
        for row in rows[4:]: complete &= row.get('evidence') == {key: True for key in expected_keys[row['name']]}
    value.update(checkpoint_mode='stage1-green', product_green=bool(complete), qualifying_baseline_red=False, adapter_assertions=adapter, commands=records, producer_commands=producer_commands, validation_source=source)
    (root / 'red-adjudication.json').write_text(json.dumps(value) + '\n')
    print(json.dumps({'product_green': bool(complete), 'native_selected_total':26,'adapter_selected_total':102}))
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as summary: summary.write('Stage1 candidate GREEN: ' + str(bool(complete)).lower() + '. Native selected:26. Adapter selected:102.\n')
    raise SystemExit(0 if complete else 1)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(1)
    try:
        match sys.argv[1]:
            case 'source': source()
            case 'select': select()
            case 'native-tools': native_tools()
            case 'wasm-tools': wasm_tools()
            case 'package': package()
            case 'pins': pins()
            case 'admit': admit()
            case 'safe-result': safe_result()
            case 'raw-input': raw_input()
            case 'baseline-identity': baseline_identity()
            case 'tools-match': tools_match()
            case 'native-tests': native_tests()
            case 'declarations': declarations()
            case 'adapter-tests': adapter_tests()
            case 'copy-runtime': copy_runtime()
            case 'green': green()
            case _: raise SystemExit(1)
    except Exception as error:
        print(__import__('json').dumps({'error':'stage1-helper-failed','diagnostic_projection':helper_exception(error)}))
        raise SystemExit(1)
