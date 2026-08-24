#!/usr/bin/perl
# ---------------------------------------------------------------------------
# Local development server. Not deployed — Netlify publishes public/ only, and
# never runs this.
#
# Why it exists: opened straight off the disk as file://, Chrome treats every
# page as its own origin, so the dashboard cannot read the hidden book iframe.
# The book leaves a cache behind that covers most of it, but serving the folder
# over http is the arrangement that behaves exactly like the hosted site.
#
# Perl ships with Git for Windows, so there is nothing to install.
# Started for you by run-local.cmd; or by hand:
#     perl tools/serve.pl public 8791
# ---------------------------------------------------------------------------
use strict; use warnings;
use IO::Socket::INET;

my $root = shift or die "usage: serve.pl <root> [port]\n";
my $port = shift || 8787;

my $srv = IO::Socket::INET->new(
  LocalAddr => '127.0.0.1', LocalPort => $port,
  Proto => 'tcp', Listen => 16, ReuseAddr => 1
) or die "listen failed: $!\n";

my %TYPE = (
  html => 'text/html; charset=utf-8',
  js   => 'text/javascript; charset=utf-8',
  css  => 'text/css; charset=utf-8',
  json => 'application/json',
);

print "serving $root on http://127.0.0.1:$port/\n";
while (my $c = $srv->accept) {
  my $req = <$c>;
  next unless defined $req;
  while (defined(my $h = <$c>)) { last if $h =~ /^\r?\n$/; }
  my ($path) = $req =~ m{^GET\s+(\S+)} ;
  $path = '/index.html' unless defined $path;
  $path =~ s/\?.*$//;
  $path =~ s/%20/ /g;
  $path = '/index.html' if $path eq '/';
  $path =~ s{\.\.}{}g;
  my $file = "$root$path";
  binmode $c, ':raw';
  $c->autoflush(1);
  if (-f $file) {
    my ($ext) = $file =~ /\.(\w+)$/;
    my $type = $TYPE{lc($ext || '')} || 'application/octet-stream';
    open my $fh, '<:raw', $file or next;
    local $/; my $body = <$fh>; close $fh;
    my $head = "HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: " .
               length($body) . "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
    write_all($c, $head . $body);
  } else {
    write_all($c, "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found");
  }
  # flush before tearing the socket down, or a large body gets truncated
  shutdown($c, 1);
  close $c;
}

sub write_all {
  my ($sock, $buf) = @_;
  my $off = 0;
  while ($off < length($buf)) {
    my $n = syswrite($sock, $buf, length($buf) - $off, $off);
    last unless defined $n && $n > 0;
    $off += $n;
  }
}
