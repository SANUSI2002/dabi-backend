// Browser adapter for Rv at /signup/organisation/:type. Pass File objects,
// not the demo documentNames payload; never persist a failed signup locally.
const allow = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unexpected registration fields');
};
export const mapOrganisationRegistration = async (form) => {
  allow(form, ['organisationType', 'organisation', 'representative', 'regulatory', 'services', 'operatingInfo', 'documents', 'consent']);
  allow(form.organisation, ['entityName', 'facilityTypeOther', 'legalName', 'country', 'state', 'city', 'address', 'phone', 'email', 'website']);
  if (form.organisation.facilityTypeOther) throw new Error('Facility type is not a visible form field');
  allow(form.documents, ['businessRegistration', 'facilityLicense', 'pharmacyLicense', 'representativeId']);
  const { facilityTypeOther, website, ...organisation } = form.organisation;
  void facilityTypeOther;
  if (form.organisationType === 'pharmacy' && website) organisation.website = website;
  else if (website) throw new Error('Website applies only to Pharmacy');
  const documents = {};
  for (const [key, file] of Object.entries(form.documents)) {
    if (!file) continue;
    if (file.size > 5 * 1024 * 1024 || !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) throw new Error('Use a PDF, JPEG or PNG file up to 5 MiB');
    const bytes = new globalThis.Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    documents[key] = { name: file.name, contentType: file.type, base64: globalThis.btoa(binary) };
  }
  return { organisationType: form.organisationType, organisation, representative: { ...form.representative }, regulatory: { ...form.regulatory }, documents, consent: { ...form.consent }, ...(form.organisationType === 'hospital' && form.services !== undefined ? { services: form.services } : {}), ...(form.organisationType === 'pharmacy' && form.operatingInfo !== undefined ? { operatingInfo: form.operatingInfo } : {}) };
};
export const submitOrganisationRegistration = async (form, fetchImpl = globalThis.fetch) => {
  const response = await fetchImpl('/api/v1/organisations/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await mapOrganisationRegistration(form)) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message || 'Registration failed'), { status: response.status, errors: result.errors });
  return result;
};
