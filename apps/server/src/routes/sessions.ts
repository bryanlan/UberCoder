import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppDatabase } from '../db/database.js';
import { ProjectService } from '../projects/project-service.js';
import { AuthService } from '../security/auth-service.js';
import { SessionInputRejectedError, SessionManager, StructuredRequestNotFoundError, type SessionCommandResult } from '../sessions/session-manager.js';
import { MAX_PROMPT_IMAGES, MODEL_PROFILE_KEYS, type SessionInputResponse } from '@agent-console/shared';
import { ImageStore, ImageUploadError } from '../images/store.js';
import { imagePromptSuffix } from '../images/prompt.js';
import { InputQueue } from '../sessions/input-queue.js';

const LIVE_INPUT_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

const inputBodySchema = z.object({
  text: z.string().min(1),
});
const sessionParamsSchema = z.object({
  sessionId: z.string().min(1),
});
const modelProfileRequestParamsSchema = sessionParamsSchema.extend({
  requestId: z.string().uuid(),
});
const sessionRequestParamsSchema = sessionParamsSchema.extend({
  requestId: z.string().min(1).max(256),
});
// Bounds keep a hostile or buggy client from sending an unbounded blob to the provider.
const sessionRequestBodySchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('answer'),
    answers: z.record(z.string().min(1).max(256), z.array(z.string().max(8_000)).max(32)).refine((answers) => Object.keys(answers).length <= 32, { message: 'Too many answered questions.' }),
    text: z.string().max(16_000).optional(),
  }),
  z.object({ decision: z.literal('decline') }),
]);
// A session takes a complete message (`keys: ['Enter']` with text) or Stop (`keys: ['Escape']`, nothing else). Literal keys, text
// typed into a terminal without Enter, and terminal controls went with the tmux transport.
const KEYS_CONTRACT = "Send a complete message with keys ['Enter'] and text, or keys ['Escape'] alone to stop. Terminal keys and text without Enter are not supported.";
const keystrokeBodySchema = z.object({
  submissionId: z.string().uuid().optional(),
  text: z.string().min(1).optional(),
  keys: z.array(z.string()).optional(),
  submittedText: z.string().min(1).optional(),
  imageIds: z.array(z.string().uuid()).min(1).max(MAX_PROMPT_IMAGES).optional(),
}).strict().refine((value) => value.keys?.length === 1 && (value.keys[0] === 'Enter'
  ? Boolean((value.submittedText ?? value.text)?.trim()) || Boolean(value.imageIds)
  : value.keys[0] === 'Escape' && !value.text && !value.submittedText && !value.submissionId && !value.imageIds), {
  message: KEYS_CONTRACT,
}).refine((value) => !value.submissionId || Boolean(value.submittedText?.trim()), {
  message: 'Queued submission requires a complete message and a single Enter.',
}).refine((value) => !value.imageIds || new Set(value.imageIds).size === value.imageIds.length, {
  message: 'Images require unique image IDs.',
});
const modelProfileBodySchema = z.object({
  profile: z.enum(MODEL_PROFILE_KEYS),
});

function sessionInputResponse(result: SessionCommandResult): SessionInputResponse {
  return {
    session: result.session,
    recordedUserInput: result.recordedUserInput,
    queuedInput: result.queuedInput,
  };
}

function parseSessionId(params: unknown, reply: FastifyReply): string | undefined {
  const parsed = sessionParamsSchema.safeParse(params);
  if (!parsed.success) {
    reply.code(400).send({ error: 'Invalid session route.', details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data.sessionId;
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  authService: AuthService,
  db: AppDatabase,
  projectService: ProjectService,
  sessions: SessionManager,
  images?: ImageStore,
): Promise<void> {
  app.post('/api/sessions/:sessionId/model-profile', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const sessionId = parseSessionId(request.params, reply);
    if (!sessionId) return;
    const parsed = modelProfileBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid model profile.', details: parsed.error.flatten() });
      return;
    }
    const session = sessions.getSessionById(sessionId);
    if (!session) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    const project = await projectService.getProjectBySlug(session.projectSlug);
    if (!project) {
      reply.code(404).send({ error: 'Project not found.' });
      return;
    }
    const providerSettings = projectService.getMergedProviderSettings(project, session.provider);
    if (!providerSettings.enabled) {
      reply.code(409).send({ error: `${session.provider} is disabled for this project.` });
      return;
    }
    try {
      return await sessions.requestModelProfile(sessionId, parsed.data.profile);
    } catch (error) {
      if (error instanceof SessionInputRejectedError) {
        reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.delete('/api/sessions/:sessionId/model-profile/requests/:requestId', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const parsed = modelProfileRequestParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid model-profile request route.', details: parsed.error.flatten() });
      return;
    }
    if (!sessions.getSessionById(parsed.data.sessionId)) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    try {
      return await sessions.cancelModelProfileRequest(parsed.data.sessionId, parsed.data.requestId);
    } catch (error) {
      if (error instanceof SessionInputRejectedError) {
        reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post('/api/sessions/:sessionId/input', { bodyLimit: LIVE_INPUT_BODY_LIMIT_BYTES }, async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const parsed = inputBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid input payload.', details: parsed.error.flatten() });
      return;
    }
    const sessionId = parseSessionId(request.params, reply);
    if (!sessionId) {
      return;
    }
    if (!sessions.getSessionById(sessionId)) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    try {
      return sessionInputResponse(await sessions.sendInput(sessionId, parsed.data.text));
    } catch (error) {
      if (error instanceof SessionInputRejectedError) {
        reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post('/api/sessions/:sessionId/release', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const sessionId = parseSessionId(request.params, reply);
    if (!sessionId) {
      return;
    }
    await sessions.releaseSession(sessionId);
    reply.code(204).send();
  });

  app.post('/api/sessions/:sessionId/suspend', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const sessionId = parseSessionId(request.params, reply);
    if (!sessionId) return;
    try {
      return { session: await sessions.suspendSession(sessionId) };
    } catch (error) {
      if (error instanceof SessionInputRejectedError) {
        reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post('/api/sessions/:sessionId/resume', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const sessionId = parseSessionId(request.params, reply);
    if (!sessionId) return;
    try {
      return { session: await sessions.resumeSession(sessionId) };
    } catch (error) {
      if (error instanceof SessionInputRejectedError) {
        reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  // The status synthesized from the provider transport's state (working, idle or asleep, model, context left). An asleep or
  // suspended conversation answers 404, as it always has. Any query string is ignored: there is no terminal scrollback to page.
  app.get('/api/sessions/:sessionId/screen', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    const sessionId = parseSessionId(request.params, reply);
    if (!sessionId) {
      return;
    }
    const session = sessions.getSessionById(sessionId);
    if (!session) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    const screenState = await sessions.getSessionScreen(sessionId);
    if (!screenState) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    return screenState;
  });

  app.post('/api/sessions/:sessionId/keys', { bodyLimit: LIVE_INPUT_BODY_LIMIT_BYTES }, async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch {
      return;
    }
    const parsed = keystrokeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid keystroke payload.', details: parsed.error.flatten() });
      return;
    }
    const sessionId = parseSessionId(request.params, reply);
    if (!sessionId) {
      return;
    }
    const session = sessions.getSessionById(sessionId);
    if (!session) {
      reply.code(404).send({ error: 'Session not found.' });
      return;
    }
    // Capture before image/native preflight, which can finish after a later Stop.
    const inputRevision = new InputQueue(db.sqlite).revision(sessionId);
    if (parsed.data.imageIds) {
      if (!images) throw new Error('Image storage was not configured.');
      // The message is the caption with the image envelope after it; the session manager reads `submittedText` first.
      const caption = (parsed.data.submittedText ?? parsed.data.text ?? '').trim();
      try {
        parsed.data.submittedText = caption + imagePromptSuffix(await images.resolve(parsed.data.imageIds, session), session.provider);
      } catch (error) {
        if (error instanceof ImageUploadError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
      delete parsed.data.imageIds;
    }
    try {
      return sessionInputResponse(await sessions.sendKeystrokes(sessionId, parsed.data, inputRevision));
    } catch (error) {
      if (error instanceof SessionInputRejectedError) {
        reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  // The person's answer to a question a session is holding open.
  app.post('/api/sessions/:sessionId/requests/:requestId', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch { return; }
    const params = sessionRequestParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid request route.', details: params.error.flatten() });
    const body = sessionRequestBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request answer.', details: body.error.flatten() });
    const session = sessions.getSessionById(params.data.sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found.' });
    try {
      return { session: await sessions.answerStructuredRequest(params.data.sessionId, params.data.requestId, body.data) };
    } catch (error) {
      if (error instanceof StructuredRequestNotFoundError || error instanceof SessionInputRejectedError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.delete('/api/sessions/:sessionId/queued-inputs/:requestId', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply);
    } catch { return; }
    const parsed = modelProfileRequestParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid queued message route.' });
    if (!sessions.getSessionById(parsed.data.sessionId)) return reply.code(404).send({ error: 'Session not found.' });
    try {
      return await sessions.cancelQueuedInput(parsed.data.sessionId, parsed.data.requestId);
    } catch (error) {
      if (error instanceof SessionInputRejectedError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
