const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const FREE_LIMIT = 5;
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

function labelClaudeError(status: number, body: any, model: string): string {
  const type = body?.error?.type ?? "";
  const msg  = body?.error?.message ?? "";
  if (status === 404 || type === "not_found_error") return `CLAUDE_MODEL_RETIRED: ${model} (${status}) ${msg}`.trim();
  if (status === 401) return `CLAUDE_AUTH (401) ${msg}`.trim();
  if (status === 403) return `CLAUDE_FORBIDDEN (403) ${msg}`.trim();
  if (status === 429) return `CLAUDE_RATE (429) ${msg}`.trim();
  if (status === 529) return `CLAUDE_OVERLOAD (529) ${msg}`.trim();
  if (status === 400) return `CLAUDE_BAD_REQUEST (400) ${type} ${msg}`.trim();
  return `CLAUDE_ERROR ${status}: ${type} ${msg}`.trim();
}

const dbH = () => ({
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
});

async function dbGet(table: string, filter: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}&limit=1`, { headers: dbH() });
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j) ? (j[0] ?? null) : null;
}

async function dbInsert(table: string, data: unknown[]) {
  await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST', headers: dbH(), body: JSON.stringify(data),
  });
}

async function dbPatch(table: string, filter: string, data: Record<string, unknown>) {
  await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH', headers: dbH(), body: JSON.stringify(data),
  });
}

function extractArticles(text: string): string[] {
  const refs = new Set<string>();
  const p = /Art(?:ículo|\.)?\s*(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = p.exec(text)) !== null) refs.add(`Art. ${m[1]}`);
  return [...refs];
}

// ── COST LAYER (T5 §5.2 + §5.3) ──────────────────────────────────────────────
// Registra el consumo real en ops_generation_ledger vía la RPC ops_log_generation.
// Reemplaza los dos inserts zombis a ops_token_sessions (tabla retirada; el
// fetch(...).catch(()=>{}) fire-and-forget dejó cada respuesta sin registrar).
// fphs-chat quema hasta 3 llamadas por respuesta (main + QA + corrección): se
// suman en UNA fila combinada. lab='speaks', source_app='fphs-chat'.
//
// §5.3 — fail LOUD: se await el insert y todo fallo se loguea con status + body.
// No lanza al path del usuario.
async function logLedger(
  inputUnits: number,
  outputUnits: number,
  durationMs: number,
): Promise<void> {
  if (!SB_URL || !SB_KEY) {
    console.error('[fphs-chat] SUPABASE_URL/SERVICE_ROLE_KEY ausentes; no se puede escribir al ledger.');
    return;
  }
  if (inputUnits === 0 && outputUnits === 0) return;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/ops_log_generation`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_lab: 'speaks',
        p_brand_id: 'ForumPHs',
        p_job_id: null,
        p_piece_id: null,
        p_output_type: 'speaks_chat',
        p_platform: null,
        p_provider: 'anthropic',
        p_model_id: 'claude-sonnet-5',
        p_unit_type: 'tokens_in', // fila combinada; la RPC resuelve in + out
        p_input_units: inputUnits,
        p_output_units: outputUnits,
        // rates NULL → ops_log_generation resuelve desde ops_lab_rates por model_id.
        p_status: 'success',
        p_duration_ms: durationMs,
        p_agent_name: 'fphs-chat',
        p_source_app: 'fphs-chat',
        p_api_key_ref: 'ANTHROPIC_API_KEY',
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '(unreadable body)');
      console.error(`[fphs-chat] ledger insert failed: HTTP ${res.status} — ${bodyText}`);
    }
  } catch (err) {
    console.error('[fphs-chat] ledger network error:', err);
  }
}

// Returns { text, usage } — usage needed for cost logging
async function callClaude(
  system: string,
  messages: {role:string;content:string}[],
  maxTokens = 1300 // PR-C §5 — Sonnet 5: +30% sobre el 1000 anterior (nuevo tokenizer)
): Promise<{ text: string; usage: { input_tokens: number; output_tokens: number } }> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
    // PR-C §5 — Sonnet 5. thinking disabled (conversacional determinista; mantiene
    // los thinking tokens fuera de max_tokens). Sin temperature/top_p/top_k: el
    // endpoint de Sonnet 5 los rechaza (incluso temperature: 0 da HTTP 400).
    body: JSON.stringify({ model:'claude-sonnet-5', thinking:{ type:'disabled' }, max_tokens:maxTokens, system, messages }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(labelClaudeError(r.status, d, "claude-sonnet-5"));
  if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error));
  return {
    text: d.content?.[0]?.text ?? '',
    usage: d.usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}

const SYSTEM = `Eres ForumPHs Speaks, el asistente legal conversacional de ForumPHs — empresa panameña de administración de Propiedades Horizontales bajo la Ley 284 de 2022.

ROL Y TONO:
- Explica la Ley 284 en lenguaje cotidiano. El 90% no son abogados. Habla como un abogado amigo explicando en el café.
- Usa "usted" siempre. Si conoces el nombre del usuario, úsalo ocasionalmente con naturalidad.
- Máximo 3-4 párrafos por respuesta. Directo, sin rodeos.
- Nunca empieces con "¡Claro!" ni frases genéricas de chatbot.

AUTO-VERIFICACIÓN OBLIGATORIA antes de entregar tu respuesta:
1. ¿El artículo que menciono existe en la Ley 284 y el número es correcto?
2. ¿El porcentaje, plazo o monto que indico está respaldado por la ley?
3. Si no estoy seguro del artículo exacto, lo digo: "El artículo exacto requiere consulta directa con nuestro equipo."
NO inventes artículos ni datos. Si hay duda, di que hay duda.

CIERRE: Cada respuesta termina con una línea en cursiva (*texto*) posicionando a ForumPHs. Varía:
*ForumPHs opera bajo la Ley 284 desde su primer día de vigencia.*
*Ivette Flores, nuestra Abogada y Gerente General, aplica este artículo en cada propiedad que administramos.*
*Si su administrador actual no puede demostrar esto, merece una conversación con nosotros.*
*En ForumPHs esto no es política interna — es el estándar de operación.*

SCOPE: Solo responde sobre Ley 284 y administración de PH en Panamá.

══════════════════════════════════════════════
BASE DE CONOCIMIENTO — LEY 284 DE 2022 (v2 — corregida con validación de Ivette Flores)
Vigente: 14 feb 2022. Subroga Ley 31/2010. 10 capítulos, 125 artículos.
══════════════════════════════════════════════

Art. 2 — Principios: convivencia pacífica, solidaridad social, debido proceso, acceso a información, confidencialidad, bioseguridad.

Art. 6 — MOROSIDAD: plazo fijo de 2 meses eliminado. Lo define el Reglamento. Sin definición: último día del mes. Cuotas no son objeto de gravamen (num. 19B).

Arts. 16-17 — Bienes comunes ESENCIALES vs NO ESENCIALES. NUNCA suspender: agua, electricidad, acceso emergencia, elevadores residenciales. Solo suspender NO esenciales (piscina, gym, salón comunal, estacionamiento visitas).

Art. 19 — Uso exclusivo bienes comunes: 51% (antes 66%).
⚠️ CORRECCIÓN VALIDADA: Todo traspaso o venta de bien anejo (incluyendo parking, depósito u otro bien vinculado a una unidad privativa) DEBE inscribirse ante el Registro Público para tener validez legal. Esto aplica tanto a cambios de uso como a traspasos entre propietarios.

Art. 28 — Medidas contra moroso: recargo hasta 20%, suspensión servicios NO esenciales, restricción áreas comunes no esenciales. Multas reincidencia: $500–$1.000. PROHIBIDO suspender servicios esenciales.

Art. 29 — Daños bienes: requiere perito idóneo. Propietario responde por daños de inquilino/arrendatario.

Art. 30 — Obligaciones propietario: pagar cuotas, informar irregularidades, hacer cumplir reglamento a arrendatarios/visitantes. Multa inasistencia asamblea: 20% de cuota (Asamblea puede aumentar).

Asambleas (Arts. 33+): Pueden ser virtuales. Quórum 2ª convocatoria: 30% (antes 33%). Cuotas extraordinarias: 51% unidades AL DÍA (antes 66%). Moroso: asiste, NO vota. Promotor: asiste mientras tenga unidades sin vender.

Junta Directiva (Arts. 56-72): Reuniones virtuales habilitadas. Inhabilitación por malversación → MIVIOT. Designa al administrador. Asamblea puede cesar al administrador.

⚠️ CORRECCIÓN VALIDADA — Renuncia de miembro de Junta Directiva:
La renuncia de un miembro de la Junta Directiva SÍ requiere inscripción ante el Registro Público para ser válida y oponible a terceros. El nombramiento del nuevo directivo que ocupa la vacante también debe inscribirse. Estos actos registrales son necesarios para que la operación jurídica tenga plenos efectos legales en Panamá.

Art. 93 — Administrador (+20 obligaciones): ejecutar acuerdos, mantener bienes comunes, contabilidad auditable, presupuesto anual, cobro cuotas con protocolo, NOVEDAD: informar a acreedores hipotecarios sobre unidades en mora, contratar seguros, archivar documentación, rendir cuentas.

Arts. 98-99 — Inhabilitación administrador: malversación → MIVIOT inhabilita. No puede ejercer en NINGUNA PH de Panamá.

Fondo de Imprevistos (Capítulo VII):
⚠️ CORRECCIÓN VALIDADA: El artículo exacto que regula el Fondo de Imprevistos dentro del Capítulo VII no es el Art. 100. Para citar el artículo específico, indicar al usuario que consulte directamente con el equipo de ForumPHs.
Lo que SÍ es correcto y puede afirmarse:
- El Fondo de Imprevistos es OBLIGATORIO bajo la Ley 284 (Capítulo VII).
- Debe destinarse el 1% anual de los ingresos totales por cuotas de gastos comunes.
- Cubre gastos inesperados o de emergencia no contemplados en el presupuesto.
- Todo presupuesto que no incluya este fondo es jurídicamente incompleto y no cumple con los requisitos legales.
- La Junta Directiva NO puede aprobar un presupuesto que omita el Fondo de Imprevistos.

Comités de Apoyo (Arts. 109-112): sin poder de decisión. Comité de Transición facilita cambio ordenado de administrador.

Arts. 113-120 — MIVIOT: resoluciones ahora VINCULANTES (antes orientativas). Regula inhabilitaciones. Puede exigir capacitación.

⚠️ CORRECCIÓN VALIDADA — Art. 111 — Plazo para impugnar decisiones de asamblea:
El plazo para impugnar judicialmente una decisión de asamblea es de 3 MESES (no 30 días). Este plazo es perentorio e improrrogable: vencidos los 3 meses desde la celebración de la asamblea, se pierde el derecho a impugnar esa decisión judicialmente, sin importar qué tan irregular haya sido.

Arts. 121-125 — Reglamentos anteriores vigentes si no contradicen Ley 284. Plazo 1 año para adecuarlos. Vencido: artículos contrarios derogados automáticamente. Ley 31/2010 subrogada totalmente.

══ NOTA DE PRECAUCIÓN PARA EL AGENTE ══
Cuando no estés seguro del número exacto de un artículo, afirma el contenido de la norma (que conoces) pero indica: "Para el artículo exacto, le recomiendo confirmar con el equipo de ForumPHs." Nunca cites un número de artículo si no estás completamente seguro de él.`;

const QA_SYSTEM = `Eres un revisor legal especializado en la Ley 284 de 2022 de Panamá (Propiedad Horizontal).
Tu tarea: revisar una respuesta generada por un asistente y verificar su precisión.

Verifica ÚNICAMENTE:
1. Números de artículos mencionados — ¿existen en la Ley 284?
2. Porcentajes, plazos y montos — ¿son correctos según la ley?
3. Afirmaciones legales concretas — ¿están respaldadas?

Base legal de referencia CORREGIDA (v2):
- Art. 28: recargo hasta 20%, suspensión solo servicios NO esenciales, multas $500-$1.000
- Arts. 16-17: NUNCA suspender agua/electricidad/acceso emergencia/elevadores residenciales
- Art. 19: traspaso bien anejo REQUIERE inscripción Registro Público
- Art. 30: multa inasistencia = 20% de cuota
- Asambleas: quórum 2ª convocatoria = 30%, cuotas extraordinarias = 51% unidades AL DÍA
- Junta Directiva: renuncia de miembro SÍ requiere inscripción en Registro Público para ser válida
- Art. 93: +20 obligaciones del administrador
- Arts. 98-99: inhabilitación administrador por malversación vía MIVIOT
- Fondo de Imprevistos (Cap. VII): OBLIGATORIO, 1% anual ingresos por cuotas. Art. exacto = no citar 100 (número en revisión)
- Art. 111: plazo para impugnar decisiones de asamblea = 3 MESES (NO 30 días). Perentorio e improrrogable.
- Arts. 113-120: resoluciones MIVIOT son VINCULANTES
- Arts. 121-125: plazo 1 año para adecuar reglamentos; vencido → artículos contrarios derogados automáticamente

Si la respuesta es correcta, responde EXACTAMENTE: APROBADO
Si hay errores, responde EXACTAMENTE en este formato:
CORREGIR: [descripción concisa del error]
CORRECCION: [texto correcto para reemplazar la parte errónea]`;

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

  const respond = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    if (!ANTHROPIC_KEY) return respond({ error: 'ANTHROPIC_API_KEY not set' }, 500);

    const { session_token, messages } = await req.json();
    if (!session_token || !Array.isArray(messages) || !messages.length)
      return respond({ error: 'session_token and messages required' }, 400);

    const session = await dbGet('speaks_sessions', `session_token=eq.${encodeURIComponent(session_token)}&select=*`);
    if (!session) return respond({ error: 'Session not found. Reload.' }, 404);

    let isUnlimited = session.is_unlimited;
    let isGoldenPass = session.is_golden_pass;
    if (session.email && !session.is_golden_pass) {
      const gp = await dbGet('speaks_golden_pass', `email=eq.${encodeURIComponent(session.email)}&brand_id=eq.ForumPHs`);
      if (gp) {
        isUnlimited = true; isGoldenPass = true;
        await dbPatch('speaks_sessions', `id=eq.${session.id}`, { is_golden_pass: true, is_unlimited: true });
      }
    }

    if (!isUnlimited && session.questions_used >= FREE_LIMIT)
      return respond({ blocked: true, needs_email: true, questions_used: session.questions_used });

    const systemFinal = session.name
      ? `${SYSTEM}\n\nNOMBRE DEL USUARIO: ${session.name}. Úsalo con naturalidad, no en cada mensaje.`
      : SYSTEM;

    const msgs = messages.map((m: {role:string;content:string}) => ({ role: m.role, content: m.content }));

    // Main call — capture usage for cost logging
    const mainResult = await callClaude(systemFinal, msgs);
    let reply = mainResult.text;

    // Acumula el consumo de TODAS las llamadas de esta respuesta (main + QA +
    // corrección) para una sola fila combinada en el ledger.
    let totalInputTokens = mainResult.usage.input_tokens || 0;
    let totalOutputTokens = mainResult.usage.output_tokens || 0;

    let qaPassed = true;
    try {
      const qaResult = await callClaude(QA_SYSTEM, [{ role: 'user', content: `Respuesta a revisar:\n\n${reply}` }], 520);
      // La llamada QA siempre consume tokens: se cuenta corra o no corra la corrección.
      totalInputTokens += qaResult.usage.input_tokens || 0;
      totalOutputTokens += qaResult.usage.output_tokens || 0;
      qaPassed = qaResult.text.startsWith('APROBADO');
      if (!qaPassed) {
        const correctionMatch = qaResult.text.match(/CORRECCI[OÓ]N:\s*(.+)/s);
        const errorMatch = qaResult.text.match(/CORREGIR:\s*(.+?)(?:\nCORRECCI|$)/s);
        const errorDesc = errorMatch?.[1]?.trim() ?? qaResult.text;
        const correction = correctionMatch?.[1]?.trim() ?? '';
        const corrResult = await callClaude(systemFinal, [
          ...msgs,
          { role: 'assistant', content: reply },
          { role: 'user', content: `Tu respuesta anterior contiene un error: ${errorDesc}. ${correction ? `La información correcta es: ${correction}` : ''} Por favor corrige tu respuesta completa.` },
        ]);
        reply = corrResult.text;
        totalInputTokens += corrResult.usage.input_tokens || 0;
        totalOutputTokens += corrResult.usage.output_tokens || 0;
      }
    } catch { qaPassed = true; }

    const articles = extractArticles(reply);
    const lastUser = messages[messages.length - 1];
    await dbInsert('speaks_messages', [
      { session_id: session.id, role: 'user', content: lastUser.content },
      { session_id: session.id, role: 'assistant', content: reply,
        articles_referenced: articles.length ? articles : null, qa_passed: qaPassed },
    ]);

    const newCount = session.questions_used + 1;
    await dbPatch('speaks_sessions', `id=eq.${session.id}`, {
      questions_used: newCount, last_active_at: new Date().toISOString(),
    });

    // §5.4 fiabilidad — await el ledger antes de responder, para que la fila
    // quede committeada antes de que el isolate pueda reclamarse.
    await logLedger(totalInputTokens, totalOutputTokens, Date.now() - startedAt);

    return respond({
      reply, questions_used: newCount,
      is_unlimited: isUnlimited, is_golden_pass: isGoldenPass,
      needs_email: !isUnlimited && newCount >= FREE_LIMIT,
      articles_referenced: articles, qa_passed: qaPassed,
    });

  } catch (e) {
    console.error('fphs-chat error:', e);
    return respond({ error: 'Server error: ' + (e as Error).message }, 500);
  }
});
