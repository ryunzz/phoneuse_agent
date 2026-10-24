import Foundation
import Security

/// The Mac's gateway URL and this contributor's key, from `bun run admin create-contributor`.
struct Pairing: Equatable {
    let baseURL: URL
    let key: String

    /// Accepts the printed pairing string: `http://192.168.1.20:8787#ct_...`.
    static func parse(_ text: String) -> Pairing? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hash = trimmed.firstIndex(of: "#") else { return nil }
        let key = String(trimmed[trimmed.index(after: hash)...])
        var base = String(trimmed[..<hash])
        while base.hasSuffix("/") { base.removeLast() }
        guard key.hasPrefix("ct_"), key.count > 10,
              let url = URL(string: base), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil
        else { return nil }
        return Pairing(baseURL: url, key: key)
    }

    private static let urlDefaultsKey = "pairing.baseURL"
    private static let keychainService = "com.phoneuse.tasks.contributor"

    static func load() -> Pairing? {
        guard let base = UserDefaults.standard.string(forKey: urlDefaultsKey), let url = URL(string: base) else { return nil }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let key = String(data: data, encoding: .utf8)
        else { return nil }
        return Pairing(baseURL: url, key: key)
    }

    func save() {
        Pairing.clear()
        UserDefaults.standard.set(baseURL.absoluteString, forKey: Pairing.urlDefaultsKey)
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Pairing.keychainService,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(key.utf8),
        ]
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: urlDefaultsKey)
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService] as CFDictionary)
    }
}
