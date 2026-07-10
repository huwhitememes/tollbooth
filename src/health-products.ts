/**
 * Public Health & Safety Intelligence — data products for x402 paid tools.
 *
 * Sources (all keyless / public-domain government APIs):
 * - openFDA (drug enforcement, adverse events, labeling)
 * - CPSC saferproducts.gov (consumer product recalls)
 * - NHTSA (vehicle recalls by make/model/VIN)
 *
 * Each function returns { success, data, cached, meta: { count, source, generated_at } }.
 */

// ─── helpers ─────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function fetchJson(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "TollboothBot/1.0 HealthSafety/0.9",
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function meta(count: number, source: string) {
  return { count, source, generated_at: new Date().toISOString() };
}

// ─── 1. searchDrugRecalls — openFDA drug enforcement ─────────────────────

export async function searchDrugRecalls(
  query?: string,
  limit?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 10, 1, 100);
  const search = query?.trim() || "recalling_firm:*";
  const url = `https://api.fda.gov/drug/enforcement.json?search=${encodeURIComponent(search)}&limit=${lim}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 8000 });
    const results = (json?.results ?? []).map((r: any) => ({
      recall_number: r.recall_number ?? "",
      recalling_firm: r.recalling_firm ?? "",
      product_description: r.product_description ?? "",
      reason_for_recall: r.reason_for_recall ?? "",
      classification: r.classification ?? "",
      status: r.status ?? "",
      distribution_pattern: r.distribution_pattern ?? "",
      recall_initiation_date: r.recall_initiation_date ?? "",
      report_date: r.report_date ?? "",
      state: r.state ?? "",
      country: r.country ?? "",
    }));

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "openFDA drug/enforcement"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "openFDA drug/enforcement"),
    };
  }
}

// ─── 2. searchAdverseEvents — openFDA adverse events ─────────────────────

export async function searchAdverseEvents(
  drug: string,
  limit?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 10, 1, 100);
  if (!drug?.trim()) {
    return {
      success: false,
      data: { error: "drug name required" },
      cached: false,
      meta: meta(0, "openFDA drug/event"),
    };
  }
  const search = `patient.drug.medicinalproduct:${encodeURIComponent(drug.trim())}`;
  const url = `https://api.fda.gov/drug/event.json?search=${search}&limit=${lim}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 8000 });
    const results = (json?.results ?? []).map((r: any) => {
      const patient = r.patient ?? {};
      const drugs = (patient.drug ?? []).slice(0, 5).map((d: any) => ({
        medicinalproduct: d.medicinalproduct ?? "",
        activesubstance: d.activesubstance?.activesubstancename ?? "",
        drugindication: d.drugindication ?? "",
      }));
      const reactions = (patient.reaction ?? []).slice(0, 10).map((rx: any) => rx.reactionmeddrapt ?? "");
      return {
        safetyreportid: r.safetyreportid ?? "",
        receivedate: r.receivedate ?? "",
        patient_age: patient.patientagegroup ?? "",
        patient_sex: patient.patientsex === 1 ? "male" : patient.patientsex === 2 ? "female" : "unknown",
        drugs,
        reactions,
        seriousness: r.serious ?? "",
        transmitter: r.companynumb ?? "",
      };
    });

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "openFDA drug/event"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "openFDA drug/event"),
    };
  }
}

// ─── 3. searchProductRecalls — CPSC saferproducts.gov ────────────────────

export async function searchProductRecalls(
  query?: string,
  limit?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 20, 1, 100);
  const title = query?.trim() ?? "";
  const base = "https://www.saferproducts.gov/RestWebServices/Recall";
  const url = title
    ? `${base}?RecallTitle=${encodeURIComponent(title)}&format=json`
    : `${base}?format=json`;

  try {
    const json = await fetchJson(url, { timeoutMs: 10000 });
    const raw = Array.isArray(json) ? json : json?.results ?? [];
    const results = raw.slice(0, lim).map((r: any) => ({
      recallID: r.recallID ?? "",
      title: r.title ?? "",
      description: (r.description ?? "").slice(0, 500),
      hazards: Array.isArray(r.hazards) ? r.hazards.map((h: any) => h.name ?? h) : [],
      products: Array.isArray(r.products) ? r.products.map((p: any) => p.name ?? p) : [],
      manufacturers: Array.isArray(r.manufacturers) ? r.manufacturers.map((m: any) => m.name ?? m) : [],
      recallDate: r.recallDate ?? "",
      url: r.recallURL ?? r.URL ?? "",
      status: r.status ?? "",
    }));

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "CPSC saferproducts.gov"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "CPSC saferproducts.gov"),
    };
  }
}

// ─── 4. searchVehicleRecalls — NHTSA ─────────────────────────────────────

export async function searchVehicleRecalls(
  make?: string,
  model?: string,
  vin?: string,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const ts = new Date().toISOString();

  // VIN lookup takes priority if provided
  if (vin?.trim()) {
    const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?vin=${encodeURIComponent(vin.trim())}`;
    try {
      const json = await fetchJson(url, { timeoutMs: 8000 });
      const results = (json?.results ?? []).map((r: any) => ({
        campaign_number: r.CampaignNumber ?? r.campaignNumber ?? "",
        component: r.Component ?? r.component ?? "",
        summary: r.Summary ?? r.summary ?? "",
        consequence: r.Consequence ?? r.consequence ?? "",
        remedy: r.Remedy ?? r.remedy ?? "",
        recall_date: r.ReportReceivedDate ?? r.reportReceivedDate ?? "",
        nhtsa_id: r.NHTSACampaignNumber ?? r.nhtsaCampaignNumber ?? "",
      }));

      return {
        success: true,
        data: { vin: vin.trim(), make: json?.Make ?? null, model: json?.Model ?? null, year: json?.Year ?? null, recalls: results },
        cached: false,
        meta: meta(results.length, "NHTSA recallsByVehicle (VIN)"),
      };
    } catch (e: any) {
      return {
        success: false,
        data: { error: e?.message ?? String(e), url },
        cached: false,
        meta: meta(0, "NHTSA recallsByVehicle (VIN)"),
      };
    }
  }

  // Make/Model lookup
  const mk = make?.trim();
  if (!mk) {
    return {
      success: false,
      data: { error: "Either vin or make is required" },
      cached: false,
      meta: meta(0, "NHTSA recallsByVehicle"),
    };
  }

  let url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(mk)}`;
  if (model?.trim()) url += `&model=${encodeURIComponent(model.trim())}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 8000 });
    const results = (json?.results ?? []).map((r: any) => ({
      campaign_number: r.CampaignNumber ?? r.campaignNumber ?? "",
      component: r.Component ?? r.component ?? "",
      summary: r.Summary ?? r.summary ?? "",
      consequence: r.Consequence ?? r.consequence ?? "",
      remedy: r.Remedy ?? r.remedy ?? "",
      recall_date: r.ReportReceivedDate ?? r.reportReceivedDate ?? "",
      nhtsa_id: r.NHTSACampaignNumber ?? r.nhtsaCampaignNumber ?? "",
    }));

    return {
      success: true,
      data: { make: mk, model: model?.trim() ?? null, recalls: results },
      cached: false,
      meta: meta(results.length, "NHTSA recallsByVehicle"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "NHTSA recallsByVehicle"),
    };
  }
}

// ─── 5. searchDrugLabels — openFDA drug labeling ─────────────────────────

export async function searchDrugLabels(
  drug_name: string,
  limit?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 5, 1, 100);
  if (!drug_name?.trim()) {
    return {
      success: false,
      data: { error: "drug_name required" },
      cached: false,
      meta: meta(0, "openFDA drug/label"),
    };
  }

  const search = `openfda.brand_name:${encodeURIComponent(drug_name.trim())}`;
  const url = `https://api.fda.gov/drug/label.json?search=${search}&limit=${lim}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 8000 });
    const results = (json?.results ?? []).map((r: any) => {
      const openfda = r.openfda ?? {};
      return {
        id: r.id ?? "",
        effective_time: r.effective_time ?? "",
        brand_names: openfda.brand_name ?? [],
        generic_names: openfda.generic_name ?? [],
        manufacturer: openfda.manufacturer_name ?? [],
        product_type: openfda.product_type ?? [],
        route: openfda.route ?? [],
        purpose: (r.purpose ?? []).slice(0, 5),
        indications_and_usage: (r.indications_and_usage ?? []).map((s: string) => s.slice(0, 400)),
        warnings: (r.warnings ?? []).map((s: string) => s.slice(0, 400)),
        dosage_and_administration: (r.dosage_and_administration ?? []).map((s: string) => s.slice(0, 400)),
        active_ingredients: (r.active_ingredient ?? []).slice(0, 10),
        inactive_ingredients: (r.inactive_ingredient ?? []).slice(0, 10),
        storage_and_handling: (r.storage_and_handling ?? []).slice(0, 3),
      };
    });

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "openFDA drug/label"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "openFDA drug/label"),
    };
  }
}

// ─── 6. searchDiseaseOutbreaks — CDC Socrata (data.cdc.gov) ──────────────

export async function searchDiseaseOutbreaks(
  query?: string,
  limit?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 20, 1, 100);
  const q = query?.trim() ?? "";

  // CDC Socrata — "Cases of Selected Notifiable Diseases" dataset
  // This is a widely available public health surveillance dataset
  let url =
    "https://data.cdc.gov/resource/n8mc-b4w4.json?$limit=" + lim +
    "&$order=case_onset_date DESC";
  if (q) {
    url += `&$where=lower( disease) LIKE '%25${encodeURIComponent(q.toLowerCase())}%25'`;
  }

  try {
    const json = await fetchJson(url, { timeoutMs: 10000 });
    const raw = Array.isArray(json) ? json : [];
    const results = raw.slice(0, lim).map((r: any) => ({
      disease: r.disease ?? "",
      location: r.county ? `${r.county}, ${r.state ?? ""}`.trim() : r.state ?? "",
      state: r.state ?? "",
      county: r.county ?? null,
      case_count: r.cases ? parseInt(r.cases, 10) || 0 : r.case_count ?? 0,
      case_onset_date: r.case_onset_date ?? null,
      date_range: r.case_onset_date
        ? `${r.case_onset_date}${r.case_report_date ? " to " + r.case_report_date : ""}`
        : null,
      severity: r.outcome === "death" ? "severe" : r.outcome === "hospitalized" ? "moderate" : "mild",
      age_group: r.age_group ?? null,
      sex: r.sex ?? null,
      race: r.race ?? null,
      cdc_report_date: r.cdc_report_date ?? null,
    }));

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "CDC Socrata (data.cdc.gov)"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "CDC Socrata (data.cdc.gov)"),
    };
  }
}

// ─── 7. searchFoodSafety — openFDA food enforcement ─────────────────────

export async function searchFoodSafety(
  query?: string,
  limit?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 20, 1, 100);
  const search = query?.trim() || "status:Ongoing";
  const url = `https://api.fda.gov/food/enforcement.json?search=${encodeURIComponent(search)}&limit=${lim}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 8000 });
    const results = (json?.results ?? []).map((r: any) => ({
      recall_number: r.recall_number ?? "",
      product_description: r.product_description ?? "",
      product_quantity: r.product_quantity ?? "",
      product_type: r.product_type ?? "",
      reason_for_recall: r.reason_for_recall ?? "",
      recalling_firm: r.recalling_firm ?? "",
      classification: r.classification ?? "",
      status: r.status ?? "",
      distribution_pattern: r.distribution_pattern ?? "",
      recall_initiation_date: r.recall_initiation_date ?? "",
      report_date: r.report_date ?? "",
      state: r.state ?? "",
      country: r.country ?? "",
      city: r.city ?? "",
      code_info: (r.code_info ?? "").slice(0, 500),
      url: r.recall_number
        ? `https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/${r.recall_number}`
        : "",
    }));

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "openFDA food/enforcement"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "openFDA food/enforcement"),
    };
  }
}
