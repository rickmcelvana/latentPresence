//! The embeddings client (ADR-44): `POST {baseUrl}/embeddings` with `{ model, input: [...] }`,
//! the OpenAI shape every local server speaks (Ollama, LM Studio, llama.cpp, vLLM).
//!
//! Thirty-two chunks to a request, a prefix put before each (`nomic-embed-text` is trained on
//! `search_document: `), the person's own headers, two minutes to answer (a first call loads
//! the model: 21.7 s measured, `docs/SURFACE.md`). A vector of the wrong width fails the job
//! with that said - writing it would fail in the database a round trip later, naming nothing.

use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, HeaderName, HeaderValue};
use serde::Deserialize;

use super::config::EmbeddingConfig;

/// Chunks sent in one request.
pub const BATCH: usize = 32;
const TIMEOUT: Duration = Duration::from_secs(120);

pub struct Embedder {
    client: reqwest::Client,
    config: EmbeddingConfig,
}

#[derive(Deserialize)]
struct Response {
    data: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    index: Option<usize>,
    embedding: Vec<f32>,
}

impl Embedder {
    pub fn new(config: EmbeddingConfig) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            // A redirect would send the person's token somewhere they did not name.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("could not start an HTTP client: {error}"))?;
        Ok(Self { client, config })
    }

    pub fn config(&self) -> &EmbeddingConfig {
        &self.config
    }

    /// A vector for each text, in order: the document prefix put on, thirty-two at a time.
    pub async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let mut vectors = Vec::with_capacity(texts.len());
        for batch in texts.chunks(BATCH) {
            vectors.extend(self.embed_batch(batch).await?);
        }
        Ok(vectors)
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let base = &self.config.base_url;
        let input: Vec<String> = texts
            .iter()
            .map(|text| format!("{}{text}", self.config.document_prefix))
            .collect();
        let body = serde_json::json!({ "model": self.config.model, "input": input });
        let mut request = self
            .client
            .post(format!("{base}/embeddings"))
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_string());
        for (name, value) in &self.config.headers {
            // Checked when the file was read; a failure here is not reachable.
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                request = request.header(name, value);
            }
        }
        // `without_url`: a base URL may carry a token (`http://user:key@host`), and an error
        // that quotes it would put it in the job's `error`, which the page shows.
        let response = request.send().await.map_err(|error| {
            format!(
                "the embedding endpoint {base} did not answer: {}",
                error.without_url()
            )
        })?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|error| {
            format!(
                "the embedding endpoint {base} stopped answering: {}",
                error.without_url()
            )
        })?;
        if !status.is_success() {
            let said: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
            return Err(format!(
                "the embedding endpoint {base} answered {}: {}",
                status.as_u16(),
                said.trim()
            ));
        }
        let parsed: Response = serde_json::from_slice(&bytes).map_err(|_| {
            format!("the embedding endpoint {base} did not answer in the OpenAI embeddings shape")
        })?;
        if parsed.data.len() != texts.len() {
            return Err(format!(
                "the embedding endpoint {base} returned {} vectors for {} texts",
                parsed.data.len(),
                texts.len()
            ));
        }
        // By `index` when it gives one (the spec says input order, but a server may not keep it).
        let mut slots: Vec<Option<Vec<f32>>> = vec![None; texts.len()];
        for (position, item) in parsed.data.into_iter().enumerate() {
            let index = item.index.unwrap_or(position);
            let width = item.embedding.len();
            if width != usize::from(self.config.dimensions) {
                return Err(format!(
                    "the embedding model {} returned vectors of {width} dimensions, but \
                     documents.json says {}",
                    self.config.model, self.config.dimensions
                ));
            }
            match slots.get_mut(index) {
                Some(slot @ None) => *slot = Some(item.embedding),
                _ => {
                    return Err(format!(
                        "the embedding endpoint {base} returned an unexpected index {index}"
                    ));
                }
            }
        }
        Ok(slots.into_iter().flatten().collect())
    }
}
