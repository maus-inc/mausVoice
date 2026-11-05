class << Gem
  OPERATING_SYSTEM_DEFAULTS = {
    ssl_ca_cert: '/etc/ssl/certs/ca-certificates.crt'
  }.freeze
end

if Gem.respond_to?(:disable_system_update_message=)
  Gem.disable_system_update_message = <<EOF
Your RubyGems was installed trough APT, and upgrading it through RubyGems
itself is unsupported. If you really need the latest version of RubyGems (tip:
you usually don't), then you need to install RubyGems (and Ruby) manually,
maybe using tools like ruby-install, rvm, etc.
EOF
end

if ENV['DEBIAN_RUBY_STANDALONE']

  $LOAD_PATH.reject! do |entry|
    entry =~ /vendor_ruby/
  end

  require 'etc'

  class << Gem

    alias upstream_ruby ruby
    def ruby
      "/usr/lib/ruby-standalone/bin/ruby"
    end

    def __root__?
      Etc.getpwuid.uid == 0
    end

    def __ruby_api_version__
      @__ruby_api_version__ ||= RbConfig::CONFIG['ruby_version']
    end

    alias upstream_default_bindir default_bindir
    def default_bindir
      __root__? && '/usr/local/bin' || File.join(Gem.user_dir, 'bin')
    end

    alias upstream_default_dir default_dir
    def default_dir
      __root__? && "/var/lib/gems/#{__ruby_api_version__}" || user_dir
    end

    alias upstream_default_path default_path
    def default_path
      [user_dir, "/var/lib/gems/#{__ruby_api_version__}", "/usr/lib/ruby/gems/#{__ruby_api_version__}"]
    end

    alias upstream_default_specifications_dir default_specifications_dir
    def default_specifications_dir
      "/usr/lib/ruby/gems/#{__ruby_api_version__}/specifications/default"
    end

    alias upstream_user_dir user_dir
    def user_dir
      File.join(Gem.user_home, '.ruby-standalone/gems', Gem.ruby_engine, __ruby_api_version__)
    end
  end

elsif !ENV['DEBIAN_DISABLE_RUBYGEMS_INTEGRATION']

  class << Gem
    alias upstream_default_dir default_dir
    def default_dir
      File.join('/', 'var', 'lib', 'gems', RbConfig::CONFIG['ruby_version'])
    end

    alias upstream_default_bindir default_bindir
    def default_bindir
      File.join('/', 'usr', 'local', 'bin')
    end

    alias upstream_default_path default_path
    def default_path
      arch = RbConfig::CONFIG['arch']
      api_version = RbConfig::CONFIG['ruby_version']

      upstream_default_path + [
        "/usr/local/lib/ruby/gems/#{api_version}",
        "/usr/lib/ruby/gems/#{api_version}",
        "/usr/lib/#{arch}/ruby/gems/#{api_version}",
        File.join('/usr/share/rubygems-integration', api_version),
        '/usr/share/rubygems-integration/all',
        "/usr/lib/#{arch}/rubygems-integration/#{api_version}"
      ]
    end

    alias :upstream_default_specifications_dir :default_specifications_dir
    def default_specifications_dir
      File.join(Gem.upstream_default_dir, 'specifications', 'default')
    end
  end

  class Gem::Specification
    begin
      alias :upstream_rubyforge_project= :rubyforge_project=
      def rubyforge_project=(x)
      end
    rescue NameError
      # rubyforge_project= was removed in RubyGems 3.1.4
      # If method rubyforge_project= is not present, that's ok
    end
  end

end
