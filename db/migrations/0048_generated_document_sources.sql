ALTER TABLE platform.document_versions
  ADD COLUMN generated_source jsonb,
  ADD CONSTRAINT generated_document_source_shape CHECK (
    generated_source IS NULL OR (
      field_id IS NULL AND category_id IS NULL
      AND jsonb_typeof(generated_source) = 'object'
      AND generated_source ?& ARRAY['templateId', 'revisionId', 'issuedIdentity',
        'releaseRoot', 'renderer', 'brandRevision', 'recordId', 'companyBrandSource', 'queries', 'logo', 'inputDigest']
      AND jsonb_typeof(generated_source->'brandRevision') = 'string'
      AND length(generated_source->>'brandRevision') BETWEEN 1 AND 180
      AND generated_source->>'recordId' = record_id::text
      AND generated_source->>'inputDigest' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(generated_source->'queries') = 'array'
      AND jsonb_array_length(generated_source->'queries') BETWEEN 1 AND 25
    ) IS TRUE
  );
