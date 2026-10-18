// The state machine is provider-independent so rollback failures can be tested
// without deploying code or touching the hosted database.
export async function deploy(platform, sha, save) {
  if (!(await platform.isLatest(sha))) return { status: 'skipped', sha };
  await platform.preflight();
  const previous = await platform.current();
  await platform.checkDatabaseCompatibility(previous.api.sha, sha);
  await platform.smoke();
  const state = {
    version: 2,
    sha,
    previous,
    candidate: {},
    status: 'releasing',
  };
  await save(state);
  try {
    state.candidate.web = await platform.stageWeb(sha);
    await save(state);
    await platform.smokeWeb(state.candidate.web.url);
    if (!(await platform.isLatest(sha))) {
      state.status = 'skipped';
      await save(state);
      return state;
    }
    await platform.assertCurrent(previous);
    // Persist intent before every mutation. A lost API response is ambiguous;
    // never blindly retry a POST or guess ownership of a resulting deployment.
    state.phase = 'deploying-api';
    await save(state);
    state.candidate.api = await platform.deployApi(sha);
    await save(state);
    await platform.waitApi(state.candidate.api.id, sha);
    await platform.smokeApi();
    await platform.assertCurrent({
      api: state.candidate.api,
      web: previous.web,
    });
    state.phase = 'promoting-web';
    await save(state);
    await platform.promoteWeb(state.candidate.web.id);
    await platform.assertCurrent(state.candidate);
    await platform.smoke();
    state.status = 'released';
    await save(state);
    return state;
  } catch (error) {
    state.status = 'failed';
    await save(state);
    try {
      await rollback(platform, state, save);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'Release failed; recovery needs operator attention.',
      );
    }
    // A recovered release is still failed, never a green deployment.
    throw error;
  }
}

export async function rollback(platform, state, save) {
  if (
    state.version !== 2 ||
    !state.previous?.api?.id ||
    !state.previous?.web?.id
  ) {
    throw new Error(
      'Invalid release checkpoint: safe startup version 2 required',
    );
  }
  await platform.preflight();
  await platform.settleApi(state.candidate.api?.id);
  const current = await platform.current();
  // Verify BOTH targets before changing either. Do not undo a later/manual
  // release when an old checkpoint is selected or another operator intervenes.
  for (const target of ['api', 'web']) {
    const allowed = [
      state.previous[target].id,
      state.candidate[target]?.id,
      state.recovery?.[target]?.id,
    ];
    if (!allowed.includes(current[target].id)) {
      throw new Error(
        `Refusing rollback: ${target} has a newer or unrelated deployment`,
      );
    }
  }
  state.recovery ??= {};
  const failures = [];
  if (current.web.id !== state.previous.web.id) {
    try {
      await platform.rollbackWeb(state.previous.web.id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (current.api.sha !== state.previous.api.sha) {
    try {
      // Rollbacks create a NEW deploy ID; remember it for interrupted recovery.
      state.recovery.api = await platform.rollbackApi(state.previous.api.id);
      await save(state);
      await platform.waitApi(state.recovery.api.id, state.previous.api.sha);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    const restored = await platform.current();
    if (
      restored.api.sha !== state.previous.api.sha ||
      restored.web.id !== state.previous.web.id
    ) {
      throw new Error('Rollback did not restore the saved versions');
    }
    await platform.smoke();
  } catch (error) {
    failures.push(error);
  }
  state.status = failures.length ? 'rollback-failed' : 'rolled-back';
  await save(state);
  if (failures.length)
    throw new AggregateError(
      failures,
      'Rollback checks failed; inspect release-state artifact and provider dashboards.',
    );
}
