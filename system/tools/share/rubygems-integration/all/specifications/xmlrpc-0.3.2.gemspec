# -*- encoding: utf-8 -*-
# stub: xmlrpc 0.3.2 ruby lib

Gem::Specification.new do |s|
  s.name = "xmlrpc".freeze
  s.version = "0.3.2"

  s.required_rubygems_version = Gem::Requirement.new(">= 0".freeze) if s.respond_to? :required_rubygems_version=
  s.require_paths = ["lib".freeze]
  s.authors = ["SHIBATA Hiroshi".freeze, "Sutou Kouhei".freeze]
  s.bindir = "exe".freeze
  s.date = "2022-05-04"
  s.description = "XMLRPC is a lightweight protocol that enables remote procedure calls over HTTP.".freeze
  s.email = ["hsbt@ruby-lang.org".freeze, "kou@cozmixng.org".freeze]
  s.files = ["Gemfile".freeze, "LICENSE.txt".freeze, "NEWS.md".freeze, "README.md".freeze, "Rakefile".freeze, "bin/console".freeze, "bin/setup".freeze, "lib/xmlrpc.rb".freeze, "lib/xmlrpc/base64.rb".freeze, "lib/xmlrpc/client.rb".freeze, "lib/xmlrpc/config.rb".freeze, "lib/xmlrpc/create.rb".freeze, "lib/xmlrpc/datetime.rb".freeze, "lib/xmlrpc/marshal.rb".freeze, "lib/xmlrpc/parser.rb".freeze, "lib/xmlrpc/server.rb".freeze, "lib/xmlrpc/utils.rb".freeze, "xmlrpc.gemspec".freeze]
  s.homepage = "https://github.com/ruby/xmlrpc".freeze
  s.licenses = ["Ruby".freeze, "BSD-2-Clause".freeze]
  s.required_ruby_version = Gem::Requirement.new(">= 2.3".freeze)
  s.rubygems_version = "3.3.5".freeze
  s.summary = "XMLRPC is a lightweight protocol that enables remote procedure calls over HTTP.".freeze

  if s.respond_to? :specification_version then
    s.specification_version = 4
  end

  if s.respond_to? :add_runtime_dependency then
    s.add_runtime_dependency(%q<webrick>.freeze, [">= 0"])
    s.add_development_dependency(%q<bundler>.freeze, [">= 0"])
    s.add_development_dependency(%q<rake>.freeze, [">= 0"])
    s.add_development_dependency(%q<test-unit>.freeze, [">= 0"])
  else
    s.add_dependency(%q<webrick>.freeze, [">= 0"])
    s.add_dependency(%q<bundler>.freeze, [">= 0"])
    s.add_dependency(%q<rake>.freeze, [">= 0"])
    s.add_dependency(%q<test-unit>.freeze, [">= 0"])
  end
end
