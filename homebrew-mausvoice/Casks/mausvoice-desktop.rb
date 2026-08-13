cask "mausvoice-desktop" do
  version "0.1.5"
  sha256 :no_check

  url "https://github.com/maus-inc/mausVoice/releases/download/{{tag}}/mausVoice_#{version}_universal.dmg",
      verified: "github.com/maus-inc/mausVoice"
  name "mausVoice"
  desc "Voice typing for your own machine, anywhere you can type"
  homepage "https://maus-inc.github.io/mausVoice/"

  livecheck do
    url "https://github.com/maus-inc/mausVoice/releases.atom"
    regex(%r{releases/tag/mausVoice-v(\d+(?:\.\d+)+)}i)
  end

  depends_on macos: ">= :ventura"

  app "mausVoice.app"

  caveats <<~EOS
    mausVoice is not notarized and requires macOS 13.3 or later. On first launch,
    right-click the app in Applications and choose Open to bypass the Gatekeeper
    "unidentified developer" warning.
  EOS

  zap trash: [
    "~/Library/Application Support/com.mausinc.desktop",
    "~/Library/Saved Application State/com.mausinc.desktop.savedState",
  ]
end
