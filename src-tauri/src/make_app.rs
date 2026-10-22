//! Make app: builds a standalone .app by copying VibeBasic.app itself.

/// Removes `/` and `:` and trims whitespace. Empty names become `Project1`.
pub fn sanitize_app_file_name(name: &str) -> String {
  let cleaned: String = name.chars().filter(|c| *c != '/' && *c != ':').collect();
  let trimmed = cleaned.trim();
  if trimmed.is_empty() {
    "Project1".to_string()
  } else {
    trimmed.to_string()
  }
}

fn transliterate(c: char) -> &'static str {
  match c {
    'æ' => "ae",
    'ø' => "o",
    'å' | 'à' | 'á' | 'â' | 'ã' | 'ä' => "a",
    'Æ' => "Ae",
    'Ø' => "O",
    'Å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' => "A",
    'è' | 'é' | 'ê' | 'ë' => "e",
    'È' | 'É' | 'Ê' | 'Ë' => "E",
    'ì' | 'í' | 'î' | 'ï' => "i",
    'Ì' | 'Í' | 'Î' | 'Ï' => "I",
    'ò' | 'ó' | 'ô' | 'õ' | 'ö' => "o",
    'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => "O",
    'ù' | 'ú' | 'û' | 'ü' => "u",
    'Ù' | 'Ú' | 'Û' | 'Ü' => "U",
    'ç' => "c",
    'Ç' => "C",
    'ñ' => "n",
    'Ñ' => "N",
    'ý' | 'ÿ' => "y",
    'Ý' => "Y",
    'ß' => "ss",
    _ => "",
  }
}

/// ASCII-only `[A-Za-z0-9]` slug; Norwegian letters transliterated; at least `App`.
pub fn ascii_slug(name: &str) -> String {
  let mut out = String::new();
  for c in name.chars() {
    if c.is_ascii_alphanumeric() {
      out.push(c);
    } else {
      out.push_str(transliterate(c));
    }
  }
  if out.is_empty() { "App".to_string() } else { out }
}

pub fn bundle_id_for(name: &str) -> String {
  format!("no.vibebasic.app.{}", ascii_slug(name).to_lowercase())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn file_name_keeps_spaces_and_norwegian() {
    assert_eq!(sanitize_app_file_name(" Mitt Program/æøå: "), "Mitt Programæøå");
  }
  #[test]
  fn empty_name() {
    assert_eq!(sanitize_app_file_name("  "), "Project1");
  }
  #[test]
  fn slug() {
    assert_eq!(ascii_slug("Kalkulator på Øya!"), "KalkulatorpaOya");
    assert_eq!(ascii_slug("!!!"), "App");
  }
  #[test]
  fn bundle_id() {
    assert_eq!(bundle_id_for("Mitt Program"), "no.vibebasic.app.mittprogram");
  }
}
